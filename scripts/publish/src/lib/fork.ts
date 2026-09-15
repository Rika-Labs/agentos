import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPackages, type Package } from "./packages.js";

const SOURCE_AGENTOS_SCOPE = "@rivet-dev/agentos";
const RELEASE_AGENTOS_SCOPE = "@rikalabs/agentos";
const LOCKSTEP_SOFTWARE = new Map([
	["@agentos-software/common", "@rikalabs/agentos-software-common"],
	["@agentos-software/apps-builder", "@rikalabs/agentos-software-apps-builder"],
	["@agentos-software/sh", "@rikalabs/agentos-software-sh"],
	["@agentos-software/manifest", "@rikalabs/agentos-software-manifest"],
]);

export function releasePackageName(name: string): string {
	if (
		name === SOURCE_AGENTOS_SCOPE ||
		name.startsWith(`${SOURCE_AGENTOS_SCOPE}-`)
	) {
		return `${RELEASE_AGENTOS_SCOPE}${name.slice(SOURCE_AGENTOS_SCOPE.length)}`;
	}
	return LOCKSTEP_SOFTWARE.get(name) ?? name;
}

export function releasePayloadText(source: string): string {
	return [...LOCKSTEP_SOFTWARE].reduce(
		(text, [from, to]) => text.replaceAll(from, to),
		source.replaceAll(SOURCE_AGENTOS_SCOPE, RELEASE_AGENTOS_SCOPE),
	);
}

/**
 * The fork publishes only packages `releasePackageName` maps into `@rikalabs`.
 * Independently-versioned `@agentos-software/*` packages that live outside
 * `software/` (e.g. `packages/manifest`) stay on upstream's release track —
 * their `workspace:*` specs pin to upstream's published `latest` at version
 * bump time — so they must be excluded from the fork's pack/publish set rather
 * than fail the all-`@rikalabs` assertion.
 */
export function rikaPackages(repoRoot: string): Package[] {
	return discoverPackages(repoRoot).filter((pkg) =>
		releasePackageName(pkg.name).startsWith("@rikalabs/"),
	);
}

export function prepareRikaNpmPackages(repoRoot: string): number {
	const packages = rikaPackages(repoRoot);
	const outputDir = join(repoRoot, "target/rika-npm");
	rmSync(outputDir, { recursive: true, force: true });
	mkdirSync(outputDir, { recursive: true });
	const manifest: Record<string, string> = {};
	for (const pkg of packages) {
		manifest[releasePackageName(pkg.name)] = prepareRikaNpmPackage(
			pkg.dir,
			outputDir,
		);
	}
	writeFileSync(
		join(outputDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	assertRikaNpmPackages(repoRoot, outputDir);
	return packages.length;
}

export function prepareRikaNpmPackage(
	packageDir: string,
	outputDir: string,
): string {
	const staging = mkdtempSync(join(tmpdir(), "rika-pack-"));
	try {
		const original = JSON.parse(
			execFileSync(
				"npm",
				// `--foreground-scripts=false` keeps lifecycle script stdout (e.g.
				// `prepack` vendoring logs) out of the `--json` output stream.
				["pack", "--json", "--foreground-scripts=false", "--pack-destination", staging],
				{ cwd: packageDir, encoding: "utf8" },
			),
		)[0] as { filename: string; files: Array<{ path: string }> };
		if (!original.filename || !original.files?.length)
			throw new Error(`npm pack returned no artifact for ${packageDir}`);
		execFileSync("tar", [
			"-xzf",
			join(staging, original.filename),
			"-C",
			staging,
		]);
		for (const file of original.files) {
			if (!/\.(?:[cm]?js|json|ts|map)$/.test(file.path)) continue;
			const path = join(staging, "package", file.path);
			const source = readFileSync(path, "utf8");
			const transformed = releasePayloadText(source);
			if (source !== transformed) writeFileSync(path, transformed);
		}
		const packed = JSON.parse(
			execFileSync(
				"npm",
				["pack", "--json", "--ignore-scripts", "--pack-destination", outputDir],
				{
					cwd: join(staging, "package"),
					encoding: "utf8",
				},
			),
		)[0] as { filename?: string };
		if (!packed.filename)
			throw new Error(`npm pack returned no artifact for ${packageDir}`);
		return packed.filename;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

export function assertRikaNpmPackages(
	repoRoot: string,
	outputDir = join(repoRoot, "target/rika-npm"),
): void {
	const packages = rikaPackages(repoRoot).map((pkg) => ({
		...pkg,
		name: releasePackageName(pkg.name),
	}));
	if (packages.length === 0)
		throw new Error("no @rikalabs packages discovered");
	const manifest = JSON.parse(
		readFileSync(join(outputDir, "manifest.json"), "utf8"),
	) as Record<string, string>;
	const versions = new Map<string, string>();
	const extracted: Array<{
		name: string;
		root: string;
		packageJson: Record<string, unknown>;
	}> = [];
	const staging = mkdtempSync(join(tmpdir(), "rika-verify-"));
	try {
		for (const pkg of packages) {
			if (!pkg.name.startsWith("@rikalabs/")) {
				throw new Error(
					`refusing fork publish: discovered non-@rikalabs package ${pkg.name}`,
				);
			}
			const filename = manifest[pkg.name];
			if (!filename)
				throw new Error(`missing final packed artifact for ${pkg.name}`);
			const root = mkdtempSync(join(staging, "package-"));
			execFileSync("tar", ["-xzf", join(outputDir, filename), "-C", root]);
			const packageJson = JSON.parse(
				readFileSync(join(root, "package/package.json"), "utf8"),
			) as Record<string, unknown>;
			if (packageJson.name !== pkg.name)
				throw new Error(
					`${filename} contains unexpected package ${String(packageJson.name)}`,
				);
			if (typeof packageJson.version !== "string")
				throw new Error(`${pkg.name} has no packed version`);
			versions.set(pkg.name, packageJson.version);
			extracted.push({ name: pkg.name, root, packageJson });
			const listing = execFileSync("tar", ["-tzf", join(outputDir, filename)], {
				encoding: "utf8",
			})
				.trim()
				.split("\n");
			const binary = pkg.name.startsWith("@rikalabs/agentos-runtime-sidecar-")
				? "package/agentos-native-sidecar"
				: pkg.name.startsWith("@rikalabs/agentos-sidecar-")
					? "package/agentos-sidecar"
					: undefined;
			if (binary && !listing.includes(binary))
				throw new Error(
					`${pkg.name} packed artifact is missing binary: ${binary}`,
				);
			if (binary && statSync(join(root, binary)).size === 0)
				throw new Error(`${pkg.name} packed binary is empty: ${binary}`);
			for (const file of listing) {
				if (
					/\/(?:agentos-sidecar|agentos-native-sidecar)$/.test(file) &&
					!(statSync(join(root, file)).mode & 0o111)
				) {
					throw new Error(
						`${pkg.name} packed binary is not executable: ${file}`,
					);
				}
				if (!/\.(?:[cm]?js|json|ts|map)$/.test(file)) continue;
				const contents = readFileSync(join(root, file), "utf8");
				if (contents.includes(SOURCE_AGENTOS_SCOPE)) {
					throw new Error(
						`${pkg.name} payload still references ${SOURCE_AGENTOS_SCOPE}: ${file}`,
					);
				}
				for (const name of LOCKSTEP_SOFTWARE.keys()) {
					if (contents.includes(name)) {
						throw new Error(
							`${pkg.name} payload still references lockstep ${name}: ${file}`,
						);
					}
				}
			}
		}
		for (const pkg of extracted) {
			for (const field of ["dependencies", "optionalDependencies"] as const) {
				const dependencies = pkg.packageJson[field] as
					| Record<string, string>
					| undefined;
				for (const [name, version] of Object.entries(dependencies ?? {})) {
					if (!name.startsWith("@rikalabs/")) continue;
					if (!versions.has(name))
						throw new Error(
							`${pkg.name} ${field} has unpublished runtime dependency ${name}`,
						);
					if (version !== versions.get(name))
						throw new Error(
							`${pkg.name} ${field} requires ${name}@${version}, packed version is ${versions.get(name)}`,
						);
				}
			}
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
