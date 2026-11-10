import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@atproto/lex";
import { PasswordSession } from "@atproto/lex-password-session";
import { isValidTid } from "@atproto/syntax";
import type { AstroIntegration } from "astro";

import {
	buildDocumentRecord,
	DOCUMENT_COLLECTION,
	readDocuments,
	RKEY_FIELD,
	type DocumentRecord,
	type DocumentSource,
} from "./documents.ts";

export {
	buildDocumentRecord,
	DOCUMENT_COLLECTION,
	fillDocumentKeys,
	pagePath,
	readDocuments,
	RKEY_FIELD,
	type DocumentRecord,
	type DocumentSource,
} from "./documents.ts";
export { generateTid } from "./tid.ts";

/** Collection NSID for the publication record. */
export const PUBLICATION_COLLECTION = "site.standard.publication";

/** Virtual module that exposes the resolved AT-URIs to pages and layouts. */
const VIRTUAL_MODULE_ID = "virtual:astro-standard-site";
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

/** Default PDS host for accounts that have not migrated off Bluesky's infra. */
const DEFAULT_SERVICE = "https://bsky.social";

export interface StandardSiteOptions {
	/** Handle (e.g. "arrowood.dev") or DID of the account that owns the publication. */
	identifier: string;

	/** PDS host. Defaults to https://bsky.social */
	service?: string;

	/** Metadata written to the site.standard.publication record. */
	publication: {
		/**
		 * Record key of the publication. The lexicon requires a TID, which must
		 * stay the same across builds. Generate one once with `generateTid()`.
		 */
		rkey: string;
		/** Human-readable publication name. */
		name: string;
		description?: string;
		/** Defaults to the consuming project's `site` config value. */
		url?: string;
	};

	/**
	 * Posts to publish as site.standard.document records. Each post's
	 * frontmatter needs `title` and `pubDate`, and may set `description` and
	 * `editDate`. Its record key lives in `standardSiteRkey`; add missing keys
	 * with the `astro-standard-site-keys` command.
	 */
	documents?: {
		/** Glob of post files, relative to the project root. */
		pattern: string;
	};
}

/**
 * Resolve a handle to its DID using the unauthenticated
 * com.atproto.identity.resolveHandle XRPC method.
 *
 * Must NOT require credentials: the injected .well-known route needs the DID on
 * every build (including `astro dev`), whereas auth is only needed for writes.
 *
 * If `identifier` is already a DID, return it as-is.
 */
export async function resolveDid(
	service: string,
	identifier: string,
): Promise<string> {
	if (identifier.startsWith("did:")) return identifier;

	const url = `${service}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(identifier)}`;

	const response = await fetch(url).catch(cause => {
		// DNS/TLS/connection failures land here as an opaque "fetch failed".
		throw new Error(
			`Could not reach ${service} to resolve handle "${identifier}".`,
			{ cause },
		);
	});

	if (!response.ok) {
		// Truncated only for the log line — error bodies can be full HTML pages.
		const body = (await response.text()).slice(0, 300);
		throw new Error(
			`Failed to resolve handle "${identifier}" via ${service} (HTTP ${response.status}): ${body}`,
		);
	}

	// A 200 carrying non-JSON throws a SyntaxError whose message already quotes
	// the offending snippet; `cause` keeps it attached.
	const { did }: { did?: unknown } = await response.json().catch(cause => {
		throw new Error(
			`Expected JSON from com.atproto.identity.resolveHandle for "${identifier}".`,
			{ cause },
		);
	});

	if (typeof did !== "string" || !did.startsWith("did:")) {
		throw new Error(
			`com.atproto.identity.resolveHandle returned no usable DID for "${identifier}". ` +
				`Expected a "did:" string, received: ${JSON.stringify(did)}`,
		);
	}

	return did;
}

/**
 * Fields of the site.standard.publication record this integration writes.
 * A type alias, not an interface, so it satisfies lex's index-signature
 * `LexMap` constraint on `putRecord`.
 */
export type PublicationRecord = {
	$type: typeof PUBLICATION_COLLECTION;
	name: string;
	url: string;
	description?: string;
};

/**
 * Build the publication record from the integration options. `url` falls back
 * to the consuming project's `site` config value, since the lexicon requires it.
 */
export function buildPublicationRecord(
	publication: Omit<StandardSiteOptions["publication"], "rkey">,
	site: string | undefined,
): PublicationRecord {
	const url = publication.url ?? site;

	if (!url) {
		throw new Error(
			"site.standard.publication requires a url. " +
				"Set `publication.url` in the integration options or `site` in your Astro config.",
		);
	}

	return {
		$type: PUBLICATION_COLLECTION,
		name: publication.name,
		url,
		// Omit rather than write `undefined`, which is not a valid lexicon value.
		...(publication.description !== undefined && {
			description: publication.description,
		}),
	};
}


/** One record to put in the authenticated repo. */
export interface RecordWrite {
	rkey: string;
	record: PublicationRecord | DocumentRecord;
}

/**
 * Log in once and idempotently create-or-update each record. Safe to call on
 * every gated build.
 *
 * `expectedDid` guards a real footgun: if BSKY_APP_PASSWORD belongs to a
 * different account than `identifier`, records would be written to one repo
 * while .well-known advertises another.
 */
export async function putRecords(
	service: string,
	identifier: string,
	expectedDid: string,
	password: string,
	writes: RecordWrite[],
): Promise<void> {
	// AsyncDisposable: logs out when this scope exits, including on throw.
	await using session = await PasswordSession.login({
		service,
		identifier,
		password,
	});

	if (session.did !== expectedDid) {
		throw new Error(
			`BSKY_APP_PASSWORD authenticated as ${session.did}, but "${identifier}" resolves to ${expectedDid}. ` +
				"Refusing to write records to a different repo than .well-known advertises.",
		);
	}

	const client = new Client(session);

	// Sequential: a handful of records, and a failure should stop the rest.
	for (const { rkey, record } of writes) {
		// The repo defaults to the session's DID, which we just checked.
		await client.putRecord(record, rkey);
	}
}

/** Source of the virtual module, with the resolved DID baked in. */
function virtualModuleSource(did: string, publicationUri: string): string {
	return [
		`export const did = ${JSON.stringify(did)};`,
		`export const publicationUri = ${JSON.stringify(publicationUri)};`,
		"export function documentUri(rkey) {",
		`\treturn rkey ? \`at://\${did}/${DOCUMENT_COLLECTION}/\${rkey}\` : undefined;`,
		"}",
	].join("\n");
}

export default function standardSite(
	options: StandardSiteOptions,
): AstroIntegration {
	const service = options.service ?? DEFAULT_SERVICE;
	const { rkey, ...publication } = options.publication;

	// Checked up front, outside the write gate: .well-known advertises this key
	// on every build, so a bad one should fail `astro dev` too.
	if (!isValidTid(rkey)) {
		throw new Error(
			`publication.rkey must be a TID (site.standard.publication uses tid record keys), received: ${JSON.stringify(rkey)}. ` +
				"Generate one with generateTid().",
		);
	}

	return {
		name: "astro-standard-site",
		hooks: {
			"astro:config:setup": async ({
				command,
				config,
				updateConfig,
				injectRoute,
				logger,
			}) => {
				// Public, unauthenticated: always available, including in dev.
				const did = await resolveDid(service, options.identifier);
				const publicationUri = `at://${did}/${PUBLICATION_COLLECTION}/${rkey}`;

				// Read on every build so a malformed post fails `astro dev` too.
				const root = fileURLToPath(config.root);
				const documents: DocumentSource[] = options.documents
					? await readDocuments(
							options.documents.pattern,
							root,
							fileURLToPath(new URL("pages/", config.srcDir)),
						)
					: [];

				// Two independent signals must agree before we touch the network:
				// an explicit opt-in, and an actual production build.
				const repoWriteEnabled =
					process.env["ENABLE_REPO_WRITE"] === "true" && command === "build";

				if (repoWriteEnabled) {
					const password = process.env["BSKY_APP_PASSWORD"];

					// Asymmetric failure: writes were requested, so a missing
					// credential is a hard error rather than a silent skip.
					if (!password) {
						throw new Error(
							"ENABLE_REPO_WRITE=true but BSKY_APP_PASSWORD is not set.",
						);
					}

					const missing = documents.filter((doc) => doc.rkey === undefined);

					if (missing.length > 0) {
						throw new Error(
							`These posts have no "${RKEY_FIELD}" in their frontmatter:\n` +
								missing.map((doc) => `  ${path.relative(root, doc.file)}`).join("\n") +
								`\nRun: astro-standard-site-keys ${JSON.stringify(options.documents?.pattern)}`,
						);
					}

					await putRecords(service, options.identifier, did, password, [
						{ rkey, record: buildPublicationRecord(publication, config.site) },
						...documents.map((doc) => ({
							rkey: doc.rkey!,
							record: buildDocumentRecord(doc, publicationUri),
						})),
					]);

					logger.info(
						`Wrote ${publicationUri} and ${documents.length} document record(s).`,
					);
				} else {
					logger.info("Repo writes disabled; skipping record sync.");
				}

				// Pages, layouts, and the injected route are compiled as their own
				// modules and cannot read this closure, so expose the URIs here.
				const source = virtualModuleSource(did, publicationUri);

				updateConfig({
					vite: {
						plugins: [
							{
								name: "astro-standard-site",
								resolveId(id: string) {
									return id === VIRTUAL_MODULE_ID
										? RESOLVED_VIRTUAL_MODULE_ID
										: undefined;
								},
								load(id: string) {
									return id === RESOLVED_VIRTUAL_MODULE_ID ? source : undefined;
								},
							},
						],
					},
				});

				injectRoute({
					pattern: `/.well-known/${PUBLICATION_COLLECTION}`,
					entrypoint: new URL("./site.standard.publication.ts", import.meta.url),
					prerender: true,
				});
			},
			"astro:config:done": async ({ injectTypes }) => {
				// Types for the virtual module, so consuming projects can import it.
				injectTypes({
					filename: "types.d.ts",
					content: await readFile(
						new URL("./astro-standard-site.d.ts", import.meta.url),
						"utf8",
					),
				});
			},
		},
	};
}
