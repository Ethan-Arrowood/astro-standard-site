import { glob, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isValidTid } from "@atproto/syntax";
import { parse } from "yaml";

import { generateTid } from "./tid.ts";

/** Collection NSID for per-post document records. */
export const DOCUMENT_COLLECTION = "site.standard.document";

/** Frontmatter field that stores each post's document record key. */
export const RKEY_FIELD = "standardSiteRkey";

/** Matches a leading `---` frontmatter block and captures its YAML. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** A post read from disk, normalized for building its document record. */
export interface DocumentSource {
	/** Absolute path of the source file. */
	file: string;
	/** URL path of the rendered page, with a leading slash. */
	path: string;
	/** Record key from frontmatter, or undefined if the post has none yet. */
	rkey: string | undefined;
	title: string;
	description: string | undefined;
	pubDate: Date;
	editDate: Date | undefined;
}

/** Fields of the site.standard.document record this integration writes. */
export type DocumentRecord = {
	$type: typeof DOCUMENT_COLLECTION;
	site: string;
	path: string;
	title: string;
	publishedAt: string;
	description?: string;
	updatedAt?: string;
};

function parseFrontmatter(
	file: string,
	source: string,
): Record<string, unknown> {
	const match = FRONTMATTER.exec(source);
	const data: unknown = match ? parse(match[1] ?? "") : undefined;

	if (typeof data !== "object" || data === null) {
		throw new Error(`${file}: expected a YAML frontmatter block.`);
	}

	return data as Record<string, unknown>;
}

function parseDate(file: string, field: string, value: unknown): Date {
	const date =
		value instanceof Date
			? value
			: typeof value === "string"
				? new Date(value)
				: undefined;

	if (!date || Number.isNaN(date.getTime())) {
		throw new Error(
			`${file}: frontmatter "${field}" must be a date, received: ${JSON.stringify(value)}`,
		);
	}

	return date;
}

/**
 * URL path for a page file under `pagesDir`, following Astro's file-based
 * routing: drop the extension, and map `index` to its directory.
 */
export function pagePath(pagesDir: string, file: string): string {
	const relative = path.relative(pagesDir, file);

	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`${file} is not inside the pages directory ${pagesDir}.`);
	}

	const withoutExtension = relative
		.slice(0, -path.extname(relative).length)
		.split(path.sep)
		.join("/");

	return `/${withoutExtension.replace(/(^|\/)index$/, "")}`;
}

/** Glob `pattern` under `root`, sorted so record writes are deterministic. */
async function matchFiles(pattern: string, root: string): Promise<string[]> {
	const files: string[] = [];

	for await (const file of glob(pattern, { cwd: root })) {
		files.push(path.resolve(root, file));
	}

	return files.sort();
}

/**
 * Read every post matching `pattern` (relative to `root`). Throws on missing
 * required fields, or on a record key that is not a TID.
 */
export async function readDocuments(
	pattern: string,
	root: string,
	pagesDir: string,
): Promise<DocumentSource[]> {
	const files = await matchFiles(pattern, root);

	return Promise.all(
		files.map(async (file) => {
			const data = parseFrontmatter(file, await readFile(file, "utf8"));
			const { title, description, pubDate, editDate } = data;
			const rkey = data[RKEY_FIELD];

			if (typeof title !== "string" || title === "") {
				throw new Error(`${file}: frontmatter "title" is required.`);
			}

			if (
				rkey !== undefined &&
				(typeof rkey !== "string" || !isValidTid(rkey))
			) {
				throw new Error(
					`${file}: frontmatter "${RKEY_FIELD}" must be a TID, received: ${JSON.stringify(rkey)}`,
				);
			}

			return {
				file,
				path: pagePath(pagesDir, file),
				rkey,
				title,
				description: typeof description === "string" ? description : undefined,
				pubDate: parseDate(file, "pubDate", pubDate),
				editDate:
					editDate === undefined
						? undefined
						: parseDate(file, "editDate", editDate),
			};
		}),
	);
}

/** Build the document record for a post in the publication at `publicationUri`. */
export function buildDocumentRecord(
	source: DocumentSource,
	publicationUri: string,
): DocumentRecord {
	const edited =
		source.editDate !== undefined &&
		source.editDate.getTime() !== source.pubDate.getTime();

	return {
		$type: DOCUMENT_COLLECTION,
		site: publicationUri,
		path: source.path,
		title: source.title,
		publishedAt: source.pubDate.toISOString(),
		...(source.description !== undefined && {
			description: source.description,
		}),
		...(edited && { updatedAt: source.editDate!.toISOString() }),
	};
}

/**
 * Add a `standardSiteRkey` to every post matching `pattern` that lacks one.
 * The TID's timestamp is the post's pubDate, so keys sort by publish date.
 * Returns the files it changed. Commit them: keys must never change.
 */
export async function fillDocumentKeys(
	pattern: string,
	root: string,
): Promise<string[]> {
	const changed: string[] = [];

	for (const file of await matchFiles(pattern, root)) {
		const source = await readFile(file, "utf8");
		const data = parseFrontmatter(file, source);

		if (data[RKEY_FIELD] !== undefined) continue;

		const tid = generateTid(parseDate(file, "pubDate", data["pubDate"]).getTime());
		const match = FRONTMATTER.exec(source)!;
		const yamlEnd = match[0].lastIndexOf("---");
		const newline = source.includes("\r\n") ? "\r\n" : "\n";

		// Insert as the last frontmatter line, leaving the rest byte-for-byte.
		const updated =
			source.slice(0, yamlEnd) +
			`${RKEY_FIELD}: "${tid}"${newline}` +
			source.slice(yamlEnd);

		await writeFile(file, updated);
		changed.push(file);
	}

	return changed;
}
