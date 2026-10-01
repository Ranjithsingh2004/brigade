import { test, describe } from "node:test";
import * as assert from "node:assert";
import { assertFutureAtTimestamp } from "./validate-timestamp.js";

describe("assertFutureAtTimestamp", () => {
	const nowMs = 1700000000000; // 2023-11-14T22:13:20.000Z
	
	test("accepts valid future timestamps", () => {
		assert.doesNotThrow(() => assertFutureAtTimestamp(nowMs + 60000, nowMs));
		assert.doesNotThrow(() => assertFutureAtTimestamp(nowMs + 6000, nowMs));
		assert.doesNotThrow(() => assertFutureAtTimestamp(nowMs + 5000, nowMs)); // exact min lead
	});

	test("throws on past timestamps", () => {
		assert.throws(
			() => assertFutureAtTimestamp(nowMs - 60000, nowMs),
			(err: any) => err.message.includes("in the past")
		);
	});

	test("throws on exactly nowMs", () => {
		assert.throws(
			() => assertFutureAtTimestamp(nowMs, nowMs),
			(err: any) => err.message.includes("in the past") || err.message.includes("0s") // delta is 0
		);
	});

	test("throws on future timestamps within the grace window", () => {
		assert.throws(
			() => assertFutureAtTimestamp(nowMs + 4000, nowMs),
			(err: any) => err.message.includes("ahead") && err.message.includes("5 seconds in the FUTURE")
		);
	});

	test("honors custom minLeadMs", () => {
		// With a 10s lead, 6s ahead should throw
		assert.throws(
			() => assertFutureAtTimestamp(nowMs + 6000, nowMs, { minLeadMs: 10000 }),
			(err: any) => err.message.includes("ahead") && err.message.includes("10 seconds in the FUTURE")
		);
		// 10s ahead should pass
		assert.doesNotThrow(() => assertFutureAtTimestamp(nowMs + 10000, nowMs, { minLeadMs: 10000 }));
	});

	test("rejects NaN/Infinity", () => {
		assert.throws(
			() => assertFutureAtTimestamp(NaN, nowMs),
			(err: any) => err.message.includes("finite epoch-ms number")
		);
		assert.throws(
			() => assertFutureAtTimestamp(Infinity, nowMs),
			(err: any) => err.message.includes("finite epoch-ms number")
		);
	});
});
