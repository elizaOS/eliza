/**
 * Document query component for searching documents.
 * Supports query input, result limit slider, and displays search results with relevance scores.
 *
 * @param props - Document query configuration
 * @param props.characterId - Optional character ID to filter queries
 */

"use client";

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Slider,
} from "@elizaos/cloud-ui";
import { FileText, Loader2, Search } from "lucide-react";
import { useState } from "react";

import type { QueryResult } from "@/lib/types/documents";

interface DocumentQueryProps {
  characterId: string | null;
}

export function DocumentQuery({ characterId }: DocumentQueryProps) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<QueryResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!query.trim()) {
      setError("Please enter a search query");
      return;
    }

    setLoading(true);
    setError(null);
    setHasSearched(false);

    const response = await fetch("/api/v1/documents/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: query.trim(),
        limit,
        characterId: characterId || undefined,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      setLoading(false);
      throw new Error(data.error || "Failed to query documents");
    }

    const data = await response.json();
    setResults(data.results || []);
    setHasSearched(true);
    setLoading(false);
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
          <Label htmlFor="query">Search Query</Label>
          <div className="flex gap-2">
            <Input
              id="query"
              type="text"
              placeholder="Ask a question about your documents..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={loading}
              className="flex-1"
            />
            <Button type="submit" disabled={loading || !query.trim()}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Searching...
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  Search
                </>
              )}
            </Button>
          </div>
        </div>

        <div>
          <Label htmlFor="limit">
            Number of Results: <span className="font-mono">{limit}</span>
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
              <h3 className="text-lg font-semibold mb-2">No results found</h3>
              <p className="text-muted-foreground">
                Try a different query or upload more documents.
              </p>
            </div>
          ) : (
            <div>
              <h3 className="text-lg font-semibold mb-4">
                Found {results.length} result{results.length !== 1 ? "s" : ""}
              </h3>
              <div className="space-y-3">
                {results.map((result, index) => (
                  <Card key={result.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-medium">Result #{index + 1}</CardTitle>
                        <span
                          className={`text-sm font-mono ${getSimilarityColor(result.similarity)}`}
                        >
                          {(result.similarity * 100).toFixed(1)}% match
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
