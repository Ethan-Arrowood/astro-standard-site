// Install the packed package the way a consumer would, in a fresh project
// outside the repo, and check that the built entry point, its injected route,
// and its bin all load.
//
// Usage: npm run smoke-test

import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AstroIntegration } from "astro";

const PACKAGE_NAME = "@arrowood.dev/astro-standard-site";

type Integration = typeof import("../standardSiteIntegration.ts");
type SetupParams = Parameters<
	NonNullable<AstroIntegration["hooks"]["astro:config:setup"]>
>[0];

function run(command: string, args: string[], cwd: string): void {
	execFileSync(command, args, { cwd, stdio: "inherit" });
}

const repo = path.resolve(import.meta.dirname, "..");
// realpath: on macOS the temp directory is behind a /private symlink, and
// module resolution returns real paths.
const workDir = await realpath(
	await mkdtemp(path.join(tmpdir(), "astro-standard-site-smoke-")),
);

try {
	run("npm", ["pack", "--pack-destination", workDir], repo);
	const tarball = (await readdir(workDir)).find((file) => file.endsWith(".tgz"));

	if (!tarball) throw new Error(`npm pack wrote no tarball to ${workDir}`);

	const consumer = path.join(workDir, "consumer");
	await mkdir(consumer);
	run("npm", ["init", "-y"], consumer);
	run("npm", ["install", path.join(workDir, tarball), "astro"], consumer);

	// Resolve from the consumer project. A bare import here would resolve to
	// this repo's own dist/ through package self-reference.
	const entry = createRequire(path.join(consumer, "package.json")).resolve(
		PACKAGE_NAME,
	);

	if (!entry.startsWith(path.join(consumer, "node_modules") + path.sep)) {
		throw new Error(`${PACKAGE_NAME} resolved outside the consumer: ${entry}`);
	}

	const { default: standardSite, generateTid } = (await import(
		pathToFileURL(entry).href
	)) as Integration;

	let entrypoint: URL | undefined;

	await standardSite({
		identifier: "did:plc:example",
		publication: { rkey: generateTid(), name: "Smoke test" },
	}).hooks["astro:config:setup"]?.({
		command: "dev",
		config: {
			root: pathToFileURL(`${consumer}/`),
			srcDir: pathToFileURL(`${consumer}/src/`),
		},
		updateConfig() {},
		injectRoute(route: { entrypoint: URL }) {
			entrypoint = route.entrypoint;
		},
		logger: { info() {} },
	} as unknown as SetupParams);

	if (!entrypoint) throw new Error("The integration injected no route.");

	await access(entrypoint);
	console.log(`Loaded ${entrypoint.href}`);

	run(
		path.join(consumer, "node_modules/.bin/astro-standard-site-keys"),
		["nothing/*.md"],
		consumer,
	);
} finally {
	await rm(workDir, { recursive: true, force: true });
}
