/// <reference path="./astro-standard-site.d.ts" />

import { publicationUri } from "virtual:astro-standard-site";

export const prerender = true;

export function GET(): Response {
	// The endpoint returns the publication's AT-URI, not the record itself.
	return new Response(publicationUri, {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}
