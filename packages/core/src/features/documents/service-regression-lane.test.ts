/**
 * Runs the document service's ingestion, embedding, and search matrix together
 * for latency-path changes that cross those operations.
 */
import { expect, it } from "vitest";
import "./__tests__/actions-routing.test";
import "./__tests__/search.test";
import "./ctx-embeddings.test";
import "./service-batch-embed.test";
import "./service-character-ingest.test";
import { DocumentService } from "./service";

it("loads the document service regression matrix", () => {
	expect(DocumentService.serviceType).toBe("documents");
});
