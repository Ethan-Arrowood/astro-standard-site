/// <reference path="./astro-standard-site.d.ts" />

export const prerender = true;

export function GET(): Response {
	// The endpoint returns the publication's AT-URI, not the record itself.
	// rkey is the literal "self" because the publication is a singleton.
	return new Response(`at://${__STANDARD_SITE_DID__}/site.standard.publication/self`, {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}
