import { describe, expect, it } from "vitest";
import { storageS3Plugin } from "../src";
import { AwsS3Service } from "../src/services/awsS3";

describe("Storage S3 Plugin", () => {
	it("should have the correct name and description", () => {
		expect(storageS3Plugin.name).toBe("storage-s3");
		expect(storageS3Plugin.description).toBe("Plugin for storage in S3");
	});

	it("should register the AwsS3Service", () => {
		expect(storageS3Plugin.services).toContain(AwsS3Service);
	});

	it("should have no actions", () => {
		expect(storageS3Plugin.actions).toEqual([]);
	});
});
