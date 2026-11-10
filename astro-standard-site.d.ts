declare module "virtual:astro-standard-site" {
	/** DID of the account that owns the publication. */
	export const did: string;
	/** AT-URI of the site.standard.publication record. */
	export const publicationUri: string;
	/** AT-URI of a post's site.standard.document record, if it has a key. */
	export function documentUri(rkey: string | undefined): string | undefined;
}
