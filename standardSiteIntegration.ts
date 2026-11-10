import { Client } from "@atproto/lex";
import { PasswordSession } from "@atproto/lex-password-session";
import type { AstroIntegration } from "astro";

/** Collection NSID for the singleton publication record. */
export const PUBLICATION_COLLECTION = "site.standard.publication";

/** The publication record is a singleton, keyed by the literal rkey "self". */
export const PUBLICATION_RKEY = "self";

/** Default PDS host for accounts that have not migrated off Bluesky's infra. */
const DEFAULT_SERVICE = "https://bsky.social";

export interface StandardSiteOptions {
	/** Handle (e.g. "arrowood.dev") or DID of the account that owns the publication. */
	identifier: string;

	/** PDS host. Defaults to https://bsky.social */
	service?: string;

	/** Metadata written to the site.standard.publication record. */
	publication: {
		/** Human-readable publication name. */
		name: string;
		description?: string;
		/** Defaults to the consuming project's `site` config value. */
		url?: string;
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
	publication: StandardSiteOptions["publication"],
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

/**
 * Idempotently create-or-update the singleton publication record. Safe to call
 * on every gated build.
 *
 * `expectedDid` guards a real footgun: if BSKY_APP_PASSWORD belongs to a
 * different account than `identifier`, the record would be written to one repo
 * while .well-known advertises another.
 */
export async function upsertPublication(
	service: string,
	identifier: string,
	expectedDid: string,
	record: PublicationRecord,
	password: string,
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
				"Refusing to write the publication record to a different repo than .well-known advertises.",
		);
	}

	// The repo defaults to the session's DID, which we just checked.
	await new Client(session).putRecord(record, PUBLICATION_RKEY);
}

export default function standardSite(
	options: StandardSiteOptions,
): AstroIntegration {
	const service = options.service ?? DEFAULT_SERVICE;

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

					const record = buildPublicationRecord(
						options.publication,
						config.site,
					);

					await upsertPublication(
						service,
						options.identifier,
						did,
						record,
						password,
					);

					logger.info(
						`Wrote at://${did}/${PUBLICATION_COLLECTION}/${PUBLICATION_RKEY}`,
					);
				} else {
					logger.info("Repo writes disabled; skipping publication record sync.");
				}

				// Hand the resolved DID to the injected route, which is compiled as
				// its own module and cannot read this closure.
				updateConfig({
					vite: {
						define: {
							__STANDARD_SITE_DID__: JSON.stringify(did),
						},
					},
				});

				injectRoute({
					pattern: `/.well-known/${PUBLICATION_COLLECTION}`,
					entrypoint: new URL("./site.standard.publication.ts", import.meta.url),
					prerender: true,
				});
			},
		},
	};
}
