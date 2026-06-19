/**
 * Document query: semantic search over the selected character's knowledge,
 * rendering similarity-scored match cards.
 *
 * Ported from `@elizaos/cloud-frontend/src/dashboard/documents/_components/document-query.tsx`.
 * Raw `fetch()` is replaced by the typed `useQueryDocuments` mutation; the
 * 0..1 similarity → percent conversion stays in the shared isomorphic
 * `toSuccessRatePercent` helper (no client-side math).
 */

import { toSuccessRatePercent } from "@elizaos/cloud-shared/lib/services/analytics-derived";
import type { QueryResult } from "@elizaos/cloud-shared/lib/types/documents";
import { FileText, Loader2, Search } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Slider } from "../../../components/ui/slider";
import { ApiError } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { useQueryDocuments } from "../lib/documents";

interface DocumentQueryProps {
  characterId: string | null;
}

export function DocumentQuery({ characterId }: DocumentQueryProps) {
  const t = useCloudT();
  const queryDocuments = useQueryDocuments();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<QueryResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  const loading = queryDocuments.isPending;

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      setError(
        t("cloud.documents.query.enterQuery", {
          defaultValue: "Please enter a search query",
        }),
      );
      return;
    }

    setError(null);
    setHasSearched(false);

    try {
      const found = await queryDocuments.mutateAsync({
        query: query.trim(),
        limit,
        characterId,
      });
      setResults(found);
      setHasSearched(true);
    } catch (err) {
      const message =
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("cloud.documents.query.queryFailed", {
              defaultValue: "Failed to query documents",
            });
      setError(message);
    }
  };

  const getSimilarityColor = (similarity: number): string => {
    if (similarity >= 0.8) return "text-green-600";
    if (similarity >= 0.6) return "text-yellow-600";
    return "text-red-600";
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSearch} className="space-y-4">
        <div>
          <Label htmlFor="query">
            {t("cloud.documents.query.searchQuery", {
              defaultValue: "Search Query",
            })}
          </Label>
          <div className="flex gap-2">
            <Input
              id="query"
              type="text"
              placeholder={t("cloud.documents.query.placeholder", {
                defaultValue: "Ask a question about your documents...",
              })}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={loading}
              className="flex-1"
            />
            <Button type="submit" disabled={loading || !query.trim()}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("cloud.documents.query.searching", {
                    defaultValue: "Searching...",
                  })}
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  {t("cloud.documents.query.search", {
                    defaultValue: "Search",
                  })}
                </>
              )}
            </Button>
          </div>
        </div>

        <div>
          <Label htmlFor="limit">
            {t("cloud.documents.query.numberOfResults", {
              defaultValue: "Number of Results",
            })}
            : <span className="font-mono">{limit}</span>
          </Label>
          <Slider
            id="limit"
            min={1}
            max={10}
            step={1}
            value={[limit]}
            onValueChange={(values) => setLimit(values[0])}
            disabled={loading}
            className="mt-2"
          />
        </div>
      </form>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {hasSearched && (
        <div className="space-y-4">
          {results.length === 0 ? (
            <div className="text-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">
                {t("cloud.documents.query.noResults", {
                  defaultValue: "No results found",
                })}
              </h3>
              <p className="text-muted-foreground">
                {t("cloud.documents.query.noResultsBody", {
                  defaultValue:
                    "Try a different query or upload more documents.",
                })}
              </p>
            </div>
          ) : (
            <div>
              <h3 className="text-lg font-semibold mb-4">
                {t("cloud.documents.query.foundCount", {
                  defaultValue: "Found {{n}} result{{plural}}",
                  n: results.length,
                  plural: results.length !== 1 ? "s" : "",
                })}
              </h3>
              <div className="space-y-3">
                {results.map((result, index) => (
                  <Card key={result.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-medium">
                          {t("cloud.documents.query.resultNumber", {
                            defaultValue: "Result #{{n}}",
                            n: index + 1,
                          })}
                        </CardTitle>
                        <span
                          className={`text-sm font-mono ${getSimilarityColor(result.similarity)}`}
                        >
                          {t("cloud.documents.query.percentMatch", {
                            defaultValue: "{{p}}% match",
                            p: toSuccessRatePercent(result.similarity).toFixed(
                              1,
                            ),
                          })}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                        {result.content}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
