import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, before, after, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

import { PasswordSession } from "@atproto/lex-password-session";
import { isValidTid } from "@atproto/syntax";
import type { AstroIntegration } from "astro";

import standardSite, {
	buildPublicationRecord,
	generateTid,
	resolveDid,
	putRecords,
	type PublicationRecord,
} from "./standardSiteIntegration.ts";

const SERVICE = "https://pds.example";
const DID = "did:plc:czn36zm5n7syrcbxzmkcjrwg";

/** Replace global fetch for the duration of one test. */
function stubFetch(impl: (url: string) => Promise<Response>) {
	return mock.method(globalThis, "fetch", impl as typeof fetch);
}

/** Fetch stub that fails the test if it is ever called. */
function forbiddenFetch() {
	return stubFetch(async (url) => {
		assert.fail(`fetch should not have been called (got ${url})`);
	});
}

afterEach(() => {
	mock.restoreAll();
});

describe("resolveDid", () => {
	it("returns a DID identifier unchanged without hitting the network", async () => {
		forbiddenFetch();

		assert.equal(await resolveDid(SERVICE, DID), DID);
	});

	it("resolves a handle to its DID", async () => {
		stubFetch(async () => Response.json({ did: DID }));

		assert.equal(await resolveDid(SERVICE, "arrowood.dev"), DID);
	});

	it("calls the unauthenticated resolveHandle endpoint with an encoded handle", async () => {
		const fetchMock = stubFetch(async () => Response.json({ did: DID }));

		await resolveDid(SERVICE, "hello world.dev");

		assert.equal(fetchMock.mock.callCount(), 1);
		assert.equal(
			fetchMock.mock.calls[0]?.arguments[0],
			`${SERVICE}/xrpc/com.atproto.identity.resolveHandle?handle=hello%20world.dev`,
		);
	});

	describe("transport failures", () => {
		it("wraps an unreachable host and preserves the cause", async () => {
			const cause = new TypeError("fetch failed");
			stubFetch(async () => {
				throw cause;
			});

			await assert.rejects(resolveDid(SERVICE, "arrowood.dev"), (error: Error) => {
				assert.match(error.message, /Could not reach https:\/\/pds\.example/);
				assert.equal(error.cause, cause);
				return true;
			});
		});
	});

	describe("error responses", () => {
		it("includes the status and body of an XRPC error", async () => {
			stubFetch(async () =>
				Response.json(
					{ error: "InvalidRequest", message: "Unable to resolve handle" },
					{ status: 400 },
				),
			);

			await assert.rejects(resolveDid(SERVICE, "nope.invalid"), (error: Error) => {
				assert.match(error.message, /HTTP 400/);
				assert.match(error.message, /Unable to resolve handle/);
				return true;
			});
		});

		it("truncates an oversized error body", async () => {
			stubFetch(async () => new Response("x".repeat(5_000), { status: 502 }));

			await assert.rejects(resolveDid(SERVICE, "arrowood.dev"), (error: Error) => {
				assert.ok(error.message.includes("x".repeat(300)));
				assert.ok(!error.message.includes("x".repeat(301)));
				return true;
			});
		});
	});

	describe("malformed success responses", () => {
		it("wraps a 200 carrying non-JSON and preserves the SyntaxError", async () => {
			stubFetch(
				async () =>
					new Response("<html><body>502 Bad Gateway</body></html>", { status: 200 }),
			);

			await assert.rejects(resolveDid(SERVICE, "arrowood.dev"), (error: Error) => {
				assert.match(error.message, /Expected JSON/);
				assert.ok(error.cause instanceof SyntaxError);
				return true;
			});
		});

		// Regression: truncating before parsing broke payloads over the log limit.
		it("parses a valid JSON body longer than the error-log truncation limit", async () => {
			stubFetch(async () => Response.json({ did: DID, padding: "z".repeat(5_000) }));

			assert.equal(await resolveDid(SERVICE, "arrowood.dev"), DID);
		});

		for (const [label, payload] of [
			["a missing did", {}],
			["a non-string did", { did: 42 }],
			["a did without the did: prefix", { did: "plc:abc123" }],
		] as const) {
			it(`rejects ${label}`, async () => {
				stubFetch(async () => Response.json(payload));

				await assert.rejects(resolveDid(SERVICE, "arrowood.dev"), (error: Error) => {
					assert.match(error.message, /no usable DID/);
					return true;
				});
			});
		}
	});
});

const RKEY = "3m4q7ia2xxs2a";

const RECORD: PublicationRecord = {
	$type: "site.standard.publication",
	name: "Ethan Arrowood",
	url: "https://ethanarrowood.com",
};

interface CapturedRequest {
	path: string;
	body: unknown;
}

/**
 * Replace PasswordSession.login with a fake session authenticated as `did`.
 * The fake is a real lex Agent, so the real Client builds the XRPC request and
 * the fetchHandler captures it instead of sending it.
 */
function stubLogin(did: string) {
	const requests: CapturedRequest[] = [];
	const dispose = mock.fn(async () => {});

	const session = {
		did,
		async fetchHandler(path: string, init: RequestInit) {
			requests.push({ path, body: JSON.parse(String(init.body)) });
			return Response.json({
				uri: `at://${did}/site.standard.publication/${RKEY}`,
				cid: "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm",
			});
		},
		[Symbol.asyncDispose]: dispose,
	};

	const login = mock.method(PasswordSession, "login", async () => session);

	return { login, requests, dispose };
}

describe("generateTid", () => {
	it("produces valid TIDs", () => {
		for (let i = 0; i < 100; i++) {
			assert.ok(isValidTid(generateTid()));
		}
	});

	it("sorts by time", () => {
		const earlier = generateTid(Date.UTC(2026, 0, 1));
		const later = generateTid(Date.UTC(2026, 0, 2));

		assert.ok(earlier < later);
	});
});

describe("buildPublicationRecord", () => {
	it("falls back to the site config value for url", () => {
		assert.deepEqual(
			buildPublicationRecord({ name: "Ethan Arrowood" }, "https://ethanarrowood.com"),
			RECORD,
		);
	});

	it("prefers an explicit publication.url over the site config value", () => {
		const record = buildPublicationRecord(
			{ name: "Ethan Arrowood", url: "https://blog.example" },
			"https://ethanarrowood.com",
		);

		assert.equal(record.url, "https://blog.example");
	});

	it("throws when neither publication.url nor site is set", () => {
		assert.throws(
			() => buildPublicationRecord({ name: "Ethan Arrowood" }, undefined),
			/requires a url/,
		);
	});

	it("includes description only when provided", () => {
		const without = buildPublicationRecord({ name: "n" }, "https://a.example");
		const withDescription = buildPublicationRecord(
			{ name: "n", description: "d" },
			"https://a.example",
		);

		assert.ok(!("description" in without));
		assert.equal(withDescription.description, "d");
	});
});

describe("putRecords", () => {
	const DOC_RKEY = "3lzyqkfxmsc2k";
	const DOC = {
		$type: "site.standard.document",
		site: `at://${DID}/site.standard.publication/${RKEY}`,
		path: "/blog/post",
		title: "Post",
		publishedAt: "2026-01-13T18:00:00.000Z",
	} as const;

	it("logs in once and puts each record at its rkey in the session's repo", async () => {
		const { login, requests, dispose } = stubLogin(DID);

		await putRecords(SERVICE, "arrowood.dev", DID, "app-password", [
			{ rkey: RKEY, record: RECORD },
			{ rkey: DOC_RKEY, record: DOC },
		]);

		assert.equal(login.mock.callCount(), 1);
		assert.deepEqual(login.mock.calls[0]?.arguments[0], {
			service: SERVICE,
			identifier: "arrowood.dev",
			password: "app-password",
		});
		assert.deepEqual(
			requests.map((request) => request.path),
			["/xrpc/com.atproto.repo.putRecord", "/xrpc/com.atproto.repo.putRecord"],
		);
		assert.deepEqual(requests.map((request) => request.body), [
			{ repo: DID, collection: "site.standard.publication", rkey: RKEY, record: RECORD },
			{ repo: DID, collection: "site.standard.document", rkey: DOC_RKEY, record: DOC },
		]);
		assert.equal(dispose.mock.callCount(), 1);
	});

	it("refuses to write when the session belongs to a different DID", async () => {
		const { requests, dispose } = stubLogin("did:plc:someoneelse");

		await assert.rejects(
			putRecords(SERVICE, "arrowood.dev", DID, "app-password", [
				{ rkey: RKEY, record: RECORD },
			]),
			(error: Error) => {
				assert.match(error.message, /did:plc:someoneelse/);
				assert.match(error.message, new RegExp(DID));
				return true;
			},
		);

		assert.equal(requests.length, 0);
		// The session is still logged out when the guard throws.
		assert.equal(dispose.mock.callCount(), 1);
	});
});

describe("astro:config:setup", () => {
	type SetupParams = Parameters<
		NonNullable<AstroIntegration["hooks"]["astro:config:setup"]>
	>[0];

	interface VitePlugin {
		resolveId(id: string): string | undefined;
		load(id: string): string | undefined;
	}

	const ENV_KEYS = ["ENABLE_REPO_WRITE", "BSKY_APP_PASSWORD"] as const;
	const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

	// A throwaway Astro project with two posts, one missing its record key.
	let root: string;
	const KEYED_RKEY = "3lzyqkfxmsc2k";

	before(async () => {
		root = await mkdtemp(path.join(tmpdir(), "astro-standard-site-"));
		await mkdir(path.join(root, "src/pages/blog"), { recursive: true });
		await writeFile(
			path.join(root, "src/pages/blog/keyed.md"),
			`---\ntitle: "Keyed"\npubDate: 2026-01-13T12:00:00-06:00\nstandardSiteRkey: "${KEYED_RKEY}"\n---\n\nBody\n`,
		);
		await writeFile(
			path.join(root, "src/pages/blog/unkeyed.md"),
			"---\ntitle: \"Unkeyed\"\npubDate: 2026-02-01T12:00:00-06:00\n---\n\nBody\n",
		);
	});

	after(async () => {
		await rm(root, { recursive: true, force: true });
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
		for (const key of ENV_KEYS) {
			if (env[key] === undefined) delete process.env[key];
			else process.env[key] = env[key];
		}
	}

	/** Run the hook with a DID identifier, so resolveDid never fetches. */
	async function runSetup(
		command: SetupParams["command"],
		{ rkey = RKEY, pattern }: { rkey?: string; pattern?: string } = {},
	) {
		const injectRoute = mock.fn();
		const updateConfig = mock.fn();
		const rootUrl = pathToFileURL(`${root}/`);
		const params = {
			command,
			config: {
				site: "https://ethanarrowood.com",
				root: rootUrl,
				srcDir: new URL("src/", rootUrl),
			},
			updateConfig,
			injectRoute,
			logger: { info: mock.fn() },
		} as unknown as SetupParams;

		await standardSite({
			identifier: DID,
			publication: { rkey, name: "Ethan Arrowood" },
			...(pattern !== undefined && { documents: { pattern } }),
		}).hooks["astro:config:setup"]?.(params);

		const config = updateConfig.mock.calls[0]?.arguments[0] as
			| { vite: { plugins: VitePlugin[] } }
			| undefined;

		return { injectRoute, plugin: config?.vite.plugins[0] };
	}

	for (const [label, command, env] of [
		["the flag is unset", "build", {}],
		["the flag is not exactly \"true\"", "build", { ENABLE_REPO_WRITE: "1" }],
		["the command is dev", "dev", { ENABLE_REPO_WRITE: "true", BSKY_APP_PASSWORD: "x" }],
	] as const) {
		it(`skips the write when ${label}`, async () => {
			setEnv(env);
			const { login } = stubLogin(DID);

			const { injectRoute } = await runSetup(command);

			assert.equal(login.mock.callCount(), 0);
			assert.equal(injectRoute.mock.callCount(), 1);
		});
	}

	it("injects the .well-known route from a file that exists", async () => {
		setEnv({});

		const { injectRoute } = await runSetup("dev");
		const route = injectRoute.mock.calls[0]?.arguments[0] as {
			pattern: string;
			entrypoint: URL;
		};

		assert.equal(route.pattern, "/.well-known/site.standard.publication");
		await access(route.entrypoint);
	});

	it("rejects an rkey that is not a TID before touching the network", async () => {
		setEnv({});
		forbiddenFetch();

		await assert.rejects(runSetup("dev", { rkey: "self" }), /publication.rkey must be a TID/);
	});

	it("serves the AT-URIs through the virtual module", async () => {
		setEnv({});

		const { plugin } = await runSetup("dev");
		const resolved = plugin?.resolveId("virtual:astro-standard-site");
		assert.ok(resolved);
		assert.equal(plugin?.resolveId("some-other-module"), undefined);

		const source = plugin?.load(resolved) ?? "";
		const mod = await import(`data:text/javascript,${encodeURIComponent(source)}`);

		assert.equal(mod.did, DID);
		assert.equal(mod.publicationUri, `at://${DID}/site.standard.publication/${RKEY}`);
		assert.equal(
			mod.documentUri(KEYED_RKEY),
			`at://${DID}/site.standard.document/${KEYED_RKEY}`,
		);
		assert.equal(mod.documentUri(undefined), undefined);
	});

	it("throws when writes are enabled without BSKY_APP_PASSWORD", async () => {
		setEnv({ ENABLE_REPO_WRITE: "true" });
		const { login } = stubLogin(DID);

		await assert.rejects(runSetup("build"), /BSKY_APP_PASSWORD is not set/);
		assert.equal(login.mock.callCount(), 0);
	});

	it("writes the publication record when enabled on build", async () => {
		setEnv({ ENABLE_REPO_WRITE: "true", BSKY_APP_PASSWORD: "app-password" });
		const { requests } = stubLogin(DID);

		await runSetup("build");

		assert.deepEqual(requests.map((request) => request.body), [
			{ repo: DID, collection: "site.standard.publication", rkey: RKEY, record: RECORD },
		]);
	});

	it("refuses to write when a post has no record key, naming the post", async () => {
		setEnv({ ENABLE_REPO_WRITE: "true", BSKY_APP_PASSWORD: "app-password" });
		const { login } = stubLogin(DID);

		await assert.rejects(
			runSetup("build", { pattern: "src/pages/blog/*.md" }),
			(error: Error) => {
				assert.match(error.message, /unkeyed\.md/);
				assert.doesNotMatch(error.message, /\bkeyed\.md/);
				assert.match(error.message, /astro-standard-site-keys/);
				return true;
			},
		);
		assert.equal(login.mock.callCount(), 0);
	});

	it("writes a document record for each keyed post after the publication", async () => {
		setEnv({ ENABLE_REPO_WRITE: "true", BSKY_APP_PASSWORD: "app-password" });
		const { requests } = stubLogin(DID);

		await runSetup("build", { pattern: "src/pages/blog/keyed.md" });

		assert.deepEqual(requests.map((request) => request.body), [
			{ repo: DID, collection: "site.standard.publication", rkey: RKEY, record: RECORD },
			{
				repo: DID,
				collection: "site.standard.document",
				rkey: KEYED_RKEY,
				record: {
					$type: "site.standard.document",
					site: `at://${DID}/site.standard.publication/${RKEY}`,
					path: "/blog/keyed",
					title: "Keyed",
					publishedAt: "2026-01-13T18:00:00.000Z",
				},
			},
		]);
	});
});

// Opt-in: hits the real Bluesky PDS. Run with LIVE=1 npm test
describe("resolveDid (live)", { skip: process.env["LIVE"] !== "1" }, () => {
	it("resolves arrowood.dev against bsky.social", async () => {
		assert.equal(await resolveDid("https://bsky.social", "arrowood.dev"), DID);
	});
});
