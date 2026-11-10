/// <reference path="./astro-standard-site.d.ts" />

export const prerender = true;

export function GET(): Response {
	// The endpoint returns the publication's AT-URI, not the record itself.
	return new Response(__STANDARD_SITE_PUBLICATION_URI__, {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}
