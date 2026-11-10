import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { TID } from "@atproto/common-web";
import { isValidTid } from "@atproto/syntax";

import {
	buildDocumentRecord,
	fillDocumentKeys,
	pagePath,
	readDocuments,
	type DocumentSource,
} from "./documents.ts";

const PUBLICATION_URI =
	"at://did:plc:czn36zm5n7syrcbxzmkcjrwg/site.standard.publication/3mzwlxfeuv2kt";
const RKEY = "3lzyqkfxmsc2k";

let root: string;
let pagesDir: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "astro-standard-site-docs-"));
	pagesDir = path.join(root, "src/pages");
	await mkdir(path.join(pagesDir, "blog"), { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function writePost(name: string, frontmatter: string, body = "\nBody\n") {
	const file = path.join(pagesDir, "blog", name);
	await writeFile(file, `---\n${frontmatter}\n---\n${body}`);
	return file;
}

describe("pagePath", () => {
	it("drops the extension", () => {
		assert.equal(pagePath("/p/src/pages", "/p/src/pages/blog/post.mdx"), "/blog/post");
	});

	it("maps index files to their directory", () => {
		assert.equal(pagePath("/p/src/pages", "/p/src/pages/blog/index.md"), "/blog");
		assert.equal(pagePath("/p/src/pages", "/p/src/pages/index.md"), "/");
	});

	it("rejects files outside the pages directory", () => {
		assert.throws(() => pagePath("/p/src/pages", "/p/src/content/post.md"), /not inside/);
	});
});

describe("readDocuments", () => {
	it("reads frontmatter and derives the page path", async () => {
		const file = await writePost(
			"post.md",
			[
				'title: "A post"',
				'description: "About it"',
				"pubDate: 2026-01-13T12:00:00-06:00",
				"editDate: 2026-06-02T12:00:00-06:00",
				`standardSiteRkey: "${RKEY}"`,
			].join("\n"),
		);

		assert.deepEqual(await readDocuments("src/pages/blog/*.md", root, pagesDir), [
			{
				file,
				path: "/blog/post",
				rkey: RKEY,
				title: "A post",
				description: "About it",
				pubDate: new Date("2026-01-13T18:00:00.000Z"),
				editDate: new Date("2026-06-02T18:00:00.000Z"),
			},
		]);
	});

	it("leaves rkey undefined for a post without one", async () => {
		await writePost("post.md", 'title: "A post"\npubDate: 2026-01-13T12:00:00-06:00');

		const [doc] = await readDocuments("src/pages/blog/*.md", root, pagesDir);

		assert.equal(doc?.rkey, undefined);
	});

	for (const [label, frontmatter, pattern] of [
		["a missing title", "pubDate: 2026-01-13T12:00:00-06:00", /"title" is required/],
		["a missing pubDate", 'title: "A post"', /"pubDate" must be a date/],
		["an invalid pubDate", 'title: "A post"\npubDate: "someday"', /"pubDate" must be a date/],
		[
			"an rkey that is not a TID",
			'title: "A post"\npubDate: 2026-01-13T12:00:00-06:00\nstandardSiteRkey: "self"',
			/"standardSiteRkey" must be a TID/,
		],
	] as const) {
		it(`rejects ${label}, naming the file`, async () => {
			await writePost("post.md", frontmatter);

			await assert.rejects(
				readDocuments("src/pages/blog/*.md", root, pagesDir),
				(error: Error) => {
					assert.match(error.message, pattern);
					assert.match(error.message, /post\.md/);
					return true;
				},
			);
		});
	}

	it("rejects a file without frontmatter", async () => {
		await writeFile(path.join(pagesDir, "blog", "post.md"), "# No frontmatter\n");

		await assert.rejects(
			readDocuments("src/pages/blog/*.md", root, pagesDir),
			/expected a YAML frontmatter block/,
		);
	});
});

describe("buildDocumentRecord", () => {
	const source: DocumentSource = {
		file: "/p/src/pages/blog/post.md",
		path: "/blog/post",
		rkey: RKEY,
		title: "A post",
		description: undefined,
		pubDate: new Date("2026-01-13T18:00:00.000Z"),
		editDate: undefined,
	};

	it("builds the required fields and points at the publication", () => {
		assert.deepEqual(buildDocumentRecord(source, PUBLICATION_URI), {
			$type: "site.standard.document",
			site: PUBLICATION_URI,
			path: "/blog/post",
			title: "A post",
			publishedAt: "2026-01-13T18:00:00.000Z",
		});
	});

	it("includes description when present", () => {
		const record = buildDocumentRecord({ ...source, description: "About it" }, PUBLICATION_URI);

		assert.equal(record.description, "About it");
	});

	it("sets updatedAt only when editDate differs from pubDate", () => {
		const unedited = buildDocumentRecord(
			{ ...source, editDate: new Date(source.pubDate) },
			PUBLICATION_URI,
		);
		const edited = buildDocumentRecord(
			{ ...source, editDate: new Date("2026-06-02T18:00:00.000Z") },
			PUBLICATION_URI,
		);

		assert.ok(!("updatedAt" in unedited));
		assert.equal(edited.updatedAt, "2026-06-02T18:00:00.000Z");
	});
});

describe("fillDocumentKeys", () => {
	it("adds a TID to posts without one and leaves the rest of the file intact", async () => {
		const frontmatter = 'layout: ../../layouts/PostLayout.astro\ntitle: "A post"\npubDate: 2026-01-13T12:00:00-06:00';
		const file = await writePost("post.md", frontmatter, "\n## Heading\n\n---\n\nBody\n");

		assert.deepEqual(await fillDocumentKeys("src/pages/blog/*.md", root), [file]);

		const updated = await readFile(file, "utf8");
		const match = /^standardSiteRkey: "([^"]+)"$/m.exec(updated);
		assert.ok(match?.[1] && isValidTid(match[1]));
		assert.equal(
			updated,
			`---\n${frontmatter}\nstandardSiteRkey: "${match[1]}"\n---\n\n## Heading\n\n---\n\nBody\n`,
		);
	});

	it("dates the TID by the post's pubDate", async () => {
		await writePost("old.md", 'title: "Old"\npubDate: 2024-01-01T00:00:00Z');
		await writePost("new.md", 'title: "New"\npubDate: 2026-01-01T00:00:00Z');

		await fillDocumentKeys("src/pages/blog/*.md", root);
		const docs = await readDocuments("src/pages/blog/*.md", root, pagesDir);
		const rkeyOf = (title: string) => docs.find((doc) => doc.title === title)?.rkey ?? "";

		assert.ok(rkeyOf("Old") < rkeyOf("New"));
		assert.equal(
			TID.fromStr(rkeyOf("New")).timestamp(),
			Date.UTC(2026, 0, 1) * 1000,
		);
	});

	it("leaves posts that already have a key unchanged", async () => {
		const file = await writePost(
			"post.md",
			`title: "A post"\npubDate: 2026-01-13T12:00:00-06:00\nstandardSiteRkey: "${RKEY}"`,
		);
		const before = await readFile(file, "utf8");

		assert.deepEqual(await fillDocumentKeys("src/pages/blog/*.md", root), []);
		assert.equal(await readFile(file, "utf8"), before);
	});
});
