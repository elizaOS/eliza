import { customType } from "drizzle-orm/pg-core";

export const stringJsonb = customType<{ data: string; driverData: string }>({
	dataType() {
		return "jsonb";
	},
	toDriver(value: string): string {
		return JSON.stringify(value);
	},
	fromDriver(value: string): string {
		return JSON.stringify(value);
	},
});

export const numberTimestamp = customType<{ data: number; driverData: string }>(
	{
		dataType() {
			return "timestamptz";
		},
		toDriver(value: number): string {
			return new Date(value).toISOString();
		},
		fromDriver(value: string): number {
			return new Date(value).getTime();
		},
	},
);
