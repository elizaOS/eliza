import { describe, expect, it } from "vitest";
import { FileLocationResultSchema, isFileLocationResult } from "../src/types";

describe("Types", () => {
	describe("FileLocationResultSchema", () => {
		it("should validate valid FileLocationResult objects", () => {
			const validObject = { fileLocation: "s3://bucket/path/to/file.jpg" };
			const result = FileLocationResultSchema.safeParse(validObject);
			
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data).toEqual(validObject);
			}
		});
		
		it("should reject objects with missing fileLocation", () => {
			const invalidObject = {};
			const result = FileLocationResultSchema.safeParse(invalidObject);
			
			expect(result.success).toBe(false);
		});
		
		it("should reject objects with empty fileLocation", () => {
			const invalidObject = { fileLocation: "" };
			const result = FileLocationResultSchema.safeParse(invalidObject);
			
			expect(result.success).toBe(false);
		});
	});
	
	describe("isFileLocationResult", () => {
		it("should return true for valid FileLocationResult objects", () => {
			const validObject = { fileLocation: "s3://bucket/path/to/file.jpg" };
			expect(isFileLocationResult(validObject)).toBe(true);
		});
		
		it("should return false for objects with missing fileLocation", () => {
			const invalidObject = {};
			expect(isFileLocationResult(invalidObject)).toBe(false);
		});
		
		it("should return false for objects with empty fileLocation", () => {
			const invalidObject = { fileLocation: "" };
			expect(isFileLocationResult(invalidObject)).toBe(false);
		});
		
		it("should return false for non-object values", () => {
			expect(isFileLocationResult(null)).toBe(false);
			expect(isFileLocationResult(undefined)).toBe(false);
			expect(isFileLocationResult("string")).toBe(false);
			expect(isFileLocationResult(123)).toBe(false);
			expect(isFileLocationResult([])).toBe(false);
		});
	});
});
