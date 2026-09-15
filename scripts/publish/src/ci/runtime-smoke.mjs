import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { AgentOs } = await import(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "agentos-release-"));
const directory = join(root, "workspace");
await mkdir(directory);
try {
	for (const command of ["printf persisted > result; printf first", "cat result"]) {
		const sidecar = await AgentOs.createSidecar();
		try {
			const vm = await AgentOs.create({
				sidecar: { kind: "explicit", handle: sidecar },
				database: { type: "sqlite_file", path: join(root, "vm.sqlite") },
				mounts: [{
					path: "/workspace",
					plugin: { id: "host_dir", config: { hostPath: directory, readOnly: false } },
					readOnly: false,
				}],
			});
			try {
				const output = [];
				const child = await vm.process.spawn("sh", ["-c", command], {
					cwd: "/workspace",
					onStdout: (chunk) => output.push(chunk),
				});
				await vm.process.closeStdin(child.pid);
				const result = await vm.process.wait(child.pid);
				assert.equal(result.exitCode, 0);
				assert.equal(Buffer.concat(output).toString(), command === "cat result" ? "persisted" : "first");
			} finally {
				await sidecar.terminate();
				await vm.dispose();
			}
		} finally {
			await sidecar.terminate();
			assert.equal(sidecar.describe().state, "disposed");
		}
	}
	assert.equal(await readFile(join(directory, "result"), "utf8"), "persisted");
	console.log("agentOS execution, persistence, reopen, and shutdown passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
