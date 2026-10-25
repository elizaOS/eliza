/** Defines the existing database transaction handle shared by sandbox lifecycle locks, backup writes, and replacement authority. */
import { type Database } from "../../../../db/helpers";

export type LifecycleTx = Parameters<Parameters<Database["transaction"]>[0]>[0];
