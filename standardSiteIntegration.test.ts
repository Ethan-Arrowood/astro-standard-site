import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { resolveDid } from "./standardSiteIntegration.ts";

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

// Opt-in: hits the real Bluesky PDS. Run with LIVE=1 npm test
describe("resolveDid (live)", { skip: process.env["LIVE"] !== "1" }, () => {
	it("resolves arrowood.dev against bsky.social", async () => {
		assert.equal(await resolveDid("https://bsky.social", "arrowood.dev"), DID);
	});
});
