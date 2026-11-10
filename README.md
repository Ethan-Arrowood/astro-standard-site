# @arrowood.dev/astro-standard-site

An Astro integration that publishes a site to the AT Protocol with the [standard.site](https://standard.site/) lexicons. It writes a `site.standard.publication` record for the site and a `site.standard.document` record for each post, and serves the verification endpoint and link tags that tie them to your domain.

## What it does

- Serves `/.well-known/site.standard.publication`, which returns the publication's AT-URI.
- Exposes `virtual:astro-standard-site` so layouts can emit `<link rel="site.standard.document">` for each post.
- On an opted-in production build, logs in with an app password and puts the publication record and every document record in your repo. Repeat builds update the same records.

## Setup

```ts
// astro.config.ts
import { defineConfig } from "astro/config";
import standardSite from "@arrowood.dev/astro-standard-site";

export default defineConfig({
	site: "https://example.com",
	integrations: [
		standardSite({
			identifier: "example.com",
			publication: {
				rkey: "3mzwlxfeuv2kt",
				name: "Example",
			},
			documents: {
				pattern: "src/pages/blog/*.{md,mdx}",
			},
		}),
	],
});
```

| Option | Required | Description |
| --- | --- | --- |
| `identifier` | Yes | Handle or DID of the account that owns the publication. |
| `service` | No | PDS or entryway used to resolve the handle and log in. Defaults to `https://bsky.social`. |
| `publication.rkey` | Yes | TID record key of the publication. See [Record keys](#record-keys). |
| `publication.name` | Yes | Publication name. |
| `publication.description` | No | Publication description. |
| `publication.url` | No | Publication URL. Defaults to Astro's `site`. One of the two is required. |
| `documents.pattern` | No | Glob of post files, relative to the project root. Omit it to publish only the publication record. |

## Record keys

Both lexicons use TID record keys. A key must never change once its record is published: a new key creates a new record and leaves the old one behind.

Generate the publication key once and put it in the config:

```bash
node -e 'import("@arrowood.dev/astro-standard-site").then((m) => console.log(m.generateTid()))'
```

Each post stores its key in a `standardSiteRkey` frontmatter field. Add keys to posts that lack one, then commit the changes:

```bash
npx astro-standard-site-keys "src/pages/blog/*.{md,mdx}"
```

The command dates each key by the post's `pubDate`, so keys sort by publish date. It only adds lines to frontmatter and leaves posts that already have a key unchanged.

## Posts

Each post file needs YAML frontmatter with:

| Field | Required | Record field |
| --- | --- | --- |
| `title` | Yes | `title` |
| `pubDate` | Yes | `publishedAt` |
| `description` | No | `description` |
| `editDate` | No | `updatedAt`, only when it differs from `pubDate` |
| `standardSiteRkey` | For writes | Record key |

The record's `path` comes from the file's location under `src/pages`, following Astro's file-based routing. Posts in content collections aren't supported yet.

## Link tags

Import `documentUri` in the layout that renders posts and add the tag to `<head>`:

```astro
---
import { documentUri } from "virtual:astro-standard-site";
const { frontmatter } = Astro.props;
const href = documentUri(frontmatter.standardSiteRkey);
---

{href && <link rel="site.standard.document" href={href} />}
```

`documentUri` returns `undefined` for a post without a key. The module also exports `did` and `publicationUri`. Astro picks up its types from `.astro/` after the first `astro dev`, `astro build`, or `astro sync`.

## Writing records

Builds never write unless both of these hold:

- `ENABLE_REPO_WRITE` is exactly `true`.
- The command is `astro build`.

When they do, `BSKY_APP_PASSWORD` must hold an [app password](https://bsky.app/settings/app-passwords) for the account, and every post must have a key. Otherwise the build fails before logging in.

```bash
ENABLE_REPO_WRITE=true BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run build
```

Before writing, the integration checks that the app password belongs to the DID that `identifier` resolves to. If not, it refuses to write, so records can't land in a different repo than the one `.well-known` advertises.

## Limitations

- Deleting a post doesn't delete its document record. Remove it from the repo by hand.
- The package ships TypeScript source and relies on Node's type stripping, which Node doesn't apply inside `node_modules`. It works when linked from a local path (`file:`). Publishing to npm needs a build step first.
- Posts are read from files, not from Astro content collections.

## Development

```bash
npm test
npx tsc --noEmit
```

Set `LIVE=1` to also run tests that call the real Bluesky API.
