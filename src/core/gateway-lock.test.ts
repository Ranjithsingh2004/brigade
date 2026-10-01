import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { test, describe, afterEach, beforeEach } from "node:test";
import * as assert from "node:assert";

// MUST set env var BEFORE importing gateway-lock or config
const TEST_DIR = path.join(os.tmpdir(), "brigade-gateway-test-" + Date.now());
process.env.BRIGADE_STATE_DIR = TEST_DIR;

import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";

describe("Gateway Lock", () => {
	beforeEach(async () => {
		await fs.mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(TEST_DIR, { recursive: true, force: true });
	});

	test("acquires lock successfully when no lock exists", async () => {
		const handle = await acquireGatewayLock({ port: 7777 });
		assert.ok(handle, "Should return a lock handle");
		assert.equal(handle.pid, process.pid, "Should contain our PID");

		// Release it
		await handle.release();
		
		// The file should be gone
		await assert.rejects(fs.readFile(handle.path, "utf8"), { code: "ENOENT" });
	});

	test("throws GatewayLockError if lock exists and PID is alive", async () => {
		// First acquire it
		const handle = await acquireGatewayLock({ port: 7777 });
		
		// Second acquire should fail because process.pid is alive
		await assert.rejects(
			acquireGatewayLock({ port: 7777, timeoutMs: 100, pollIntervalMs: 10 }),
			(err: any) => {
				assert.ok(err instanceof GatewayLockError);
				assert.equal(err.holderPid, process.pid);
				assert.equal(err.port, 7777);
				return true;
			}
		);
		
		await handle.release();
	});

	test("recovers stale lock if holder PID is dead", async () => {
		// Create a lock file with a dead PID
		const lockPath = path.join(TEST_DIR, "gateway.lock");
		const deadPid = 999999; // Very unlikely to exist
		
		const payload = {
			pid: deadPid,
			port: 7777,
			createdAt: new Date().toISOString(),
		};
		await fs.writeFile(lockPath, JSON.stringify(payload, null, 2), "utf8");

		// Acquire should succeed and overwrite the dead lock
		const handle = await acquireGatewayLock({ port: 7777, timeoutMs: 100 });
		assert.ok(handle);
		assert.equal(handle.pid, process.pid);
		
		await handle.release();
	});
});
