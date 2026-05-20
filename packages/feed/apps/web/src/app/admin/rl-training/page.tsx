"use client";

/**
 * RL Training Admin Dashboard
 *
 * Standalone viewer and admin tool for the RL training system.
 * View benchmarks, compare models, trigger training, and manage the system.
 */

import {
  Activity,
  AlertCircle,
  CheckCircle,
  Clock,
  Play,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AdminStandalonePage } from "@/components/admin/AdminStandalonePage";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiUrl } from "@/utils/api-url";

interface ModelInfo {
  modelId: string;
  version: string;
  status: string;
  benchmarkScore: number | null;
  avgReward: number | null;
  deployedAt: string | null;
  createdAt: string;
}

interface BenchmarkSummary {
  totalBenchmarked: number;
  topModels: Array<{
    modelId: string;
    version: string;
    score: number | null;
    accuracy: number | null;
    status: string;
    createdAt: string;
  }>;
  recentModels: Array<{
    modelId: string;
    version: string;
    score: number | null;
    accuracy: number | null;
    status: string;
    createdAt: string;
  }>;
}

interface ModelSelection {
  summary: {
    bundleCount: number;
    trainedModelCount: number;
    bestModel: string | null;
    bestScore: number | null;
    recommendation: string;
  };
  selection: {
    modelId: string;
    modelPath: string;
    strategy: string;
    reason: string;
    metadata?: {
      bundleCount?: number;
      bestModelScore?: number;
      baseModel?: string;
    };
  } | null;
  selectionError: string | null;
}

interface TrainingStatus {
  ready: boolean;
  reason: string;
  stats: {
    totalTrajectories: number;
    unscoredTrajectories: number;
    scenarioGroups: number;
    dataQuality: number;
  };
}

export default function RLTrainingDashboard() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [benchmarkSummary, setBenchmarkSummary] =
    useState<BenchmarkSummary | null>(null);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(
    null,
  );
  const [trainingStatus, setTrainingStatus] = useState<TrainingStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  // Fetch all data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    // Fetch models
    const modelsRes = await fetch(apiUrl("/api/admin/training/models"));
    const modelsData = await modelsRes.json();
    if (modelsData.models) {
      setModels(modelsData.models);
    }

    // Fetch benchmark summary
    const benchmarkRes = await fetch(apiUrl("/api/admin/training/benchmark"));
    const benchmarkData = await benchmarkRes.json();
    if (benchmarkData.summary) {
      setBenchmarkSummary(benchmarkData.summary);
    }

    // Fetch model selection
    const selectionRes = await fetch(
      apiUrl("/api/admin/training/model-selection"),
    );
    const selectionData = await selectionRes.json();
    if (selectionData.success) {
      setModelSelection(selectionData);
    }

    // Fetch training status
    const statusRes = await fetch(apiUrl("/api/admin/training/trigger"));
    const statusData = await statusRes.json();
    if (statusData) {
      setTrainingStatus(statusData);
    }

    setLoading(false);
  }, []);

  // Trigger training
  const triggerTraining = async (force = false) => {
    setActionStatus("Triggering training...");
    const res = await fetch(apiUrl("/api/admin/training/trigger"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    });
    const data = await res.json();

    if (data.success) {
      setActionStatus("✅ Training triggered successfully!");
      setTimeout(() => fetchData(), 2000);
    } else {
      setActionStatus(`❌ ${data.error || "Failed to trigger training"}`);
    }
    setTimeout(() => setActionStatus(null), 5000);
  };

  // Benchmark a model
  const benchmarkModel = async (modelId: string) => {
    setActionStatus(`Benchmarking ${modelId}...`);
    const res = await fetch(apiUrl("/api/admin/training/benchmark"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId, compare: true }),
    });
    const data = await res.json();

    if (data.success) {
      setActionStatus(
        `✅ Benchmark complete! Score: ${data.benchmark.benchmarkScore.toFixed(3)}`,
      );
      setTimeout(() => fetchData(), 2000);
    } else {
      setActionStatus(`❌ ${data.error || "Benchmarking failed"}`);
    }
    setTimeout(() => setActionStatus(null), 8000);
  };

  useEffect(() => {
    fetchData();
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <AdminStandalonePage className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-bold text-3xl tracking-tight">
            RL Training Dashboard
          </h1>
          <p className="text-muted-foreground">
            Monitor and manage continuous reinforcement learning training
          </p>
        </div>
        <Button onClick={() => fetchData()} disabled={loading}>
          <RefreshCw
            className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Action Status Alert */}
      {actionStatus && (
        <Alert>
          <Activity className="h-4 w-4" />
          <AlertTitle>Action Status</AlertTitle>
          <AlertDescription>{actionStatus}</AlertDescription>
        </Alert>
      )}

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Quick Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Total Models</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">{models.length}</div>
            <p className="text-muted-foreground text-xs">
              {models.filter((m) => m.status === "deployed").length} deployed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Benchmarked</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              {benchmarkSummary?.totalBenchmarked || 0}
            </div>
            <p className="text-muted-foreground text-xs">
              {models.filter((m) => m.benchmarkScore !== null).length}/
              {models.length} models
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">
              Training Bundles
            </CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              {modelSelection?.summary.bundleCount || 0}
            </div>
            <p className="text-muted-foreground text-xs">
              {trainingStatus?.stats.totalTrajectories || 0} trajectories
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">
              Training Status
            </CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              {trainingStatus?.ready ? "✅ Ready" : "⏳ Waiting"}
            </div>
            <p className="text-muted-foreground text-xs">
              Quality:{" "}
              {((trainingStatus?.stats.dataQuality || 0) * 100).toFixed(0)}%
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Tabs */}
      <Tabs defaultValue="models" className="space-y-4">
        <TabsList>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="benchmarks">Benchmarks</TabsTrigger>
          <TabsTrigger value="selection">Model Selection</TabsTrigger>
          <TabsTrigger value="actions">Actions</TabsTrigger>
        </TabsList>

        {/* Models Tab */}
        <TabsContent value="models" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Trained Models</CardTitle>
              <CardDescription>
                All models trained through the RL system
              </CardDescription>
            </CardHeader>
            <CardContent>
              {models.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  No models found. Train your first model to get started.
                </div>
              ) : (
                <div className="space-y-3">
                  {models.map((model) => (
                    <div
                      key={model.modelId}
                      className="flex items-center justify-between rounded-lg border p-4"
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold">{model.modelId}</h3>
                          <Badge
                            variant={
                              model.status === "deployed"
                                ? "default"
                                : model.status === "ready"
                                  ? "secondary"
                                  : "outline"
                            }
                          >
                            {model.status}
                          </Badge>
                        </div>
                        <div className="mt-1 text-muted-foreground text-sm">
                          Version: {model.version}
                          {model.benchmarkScore && (
                            <> • Score: {model.benchmarkScore.toFixed(3)}</>
                          )}
                          {model.avgReward && (
                            <> • Avg Reward: {model.avgReward.toFixed(3)}</>
                          )}
                        </div>
                        <div className="mt-1 text-muted-foreground text-xs">
                          Created: {new Date(model.createdAt).toLocaleString()}
                          {model.deployedAt && (
                            <>
                              {" "}
                              • Deployed:{" "}
                              {new Date(model.deployedAt).toLocaleString()}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {!model.benchmarkScore && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => benchmarkModel(model.modelId)}
                          >
                            Benchmark
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Benchmarks Tab */}
        <TabsContent value="benchmarks" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Top Performing Models</CardTitle>
                <CardDescription>
                  Models ranked by benchmark score
                </CardDescription>
              </CardHeader>
              <CardContent>
                {benchmarkSummary?.topModels.length === 0 ? (
                  <div className="py-8 text-center text-muted-foreground">
                    No benchmarked models yet
                  </div>
                ) : (
                  <div className="space-y-3">
                    {benchmarkSummary?.topModels
                      .slice(0, 5)
                      .map((model, idx) => (
                        <div
                          key={model.modelId}
                          className="flex items-center gap-3"
                        >
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 font-bold text-primary">
                            {idx + 1}
                          </div>
                          <div className="flex-1">
                            <div className="font-medium">{model.modelId}</div>
                            <div className="text-muted-foreground text-sm">
                              Score: {model.score?.toFixed(3) || "N/A"}
                              {model.accuracy && (
                                <>
                                  {" "}
                                  • Accuracy:{" "}
                                  {(model.accuracy * 100).toFixed(1)}%
                                </>
                              )}
                            </div>
                          </div>
                          <Badge
                            variant={
                              model.status === "deployed"
                                ? "default"
                                : "secondary"
                            }
                          >
                            {model.status}
                          </Badge>
                        </div>
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent Benchmarks</CardTitle>
                <CardDescription>
                  Most recently benchmarked models
                </CardDescription>
              </CardHeader>
              <CardContent>
                {benchmarkSummary?.recentModels.length === 0 ? (
                  <div className="py-8 text-center text-muted-foreground">
                    No recent benchmarks
                  </div>
                ) : (
                  <div className="space-y-3">
                    {benchmarkSummary?.recentModels.slice(0, 5).map((model) => (
                      <div
                        key={model.modelId}
                        className="flex items-center justify-between rounded border p-3"
                      >
                        <div>
                          <div className="font-medium">{model.modelId}</div>
                          <div className="text-muted-foreground text-sm">
                            {new Date(model.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold">
                            {model.score?.toFixed(3) || "N/A"}
                          </div>
                          <div className="text-muted-foreground text-sm">
                            {model.accuracy
                              ? `${(model.accuracy * 100).toFixed(1)}%`
                              : "N/A"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Model Selection Tab */}
        <TabsContent value="selection" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Next Training Configuration</CardTitle>
              <CardDescription>
                Model selection strategy for the next training run
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {modelSelection && (
                <>
                  {/* Summary */}
                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="rounded-lg border p-4">
                      <div className="text-muted-foreground text-sm">
                        Training Bundles
                      </div>
                      <div className="font-bold text-2xl">
                        {modelSelection.summary.bundleCount}
                      </div>
                    </div>
                    <div className="rounded-lg border p-4">
                      <div className="text-muted-foreground text-sm">
                        Trained Models
                      </div>
                      <div className="font-bold text-2xl">
                        {modelSelection.summary.trainedModelCount}
                      </div>
                    </div>
                    <div className="rounded-lg border p-4">
                      <div className="text-muted-foreground text-sm">
                        Best Score
                      </div>
                      <div className="font-bold text-2xl">
                        {modelSelection.summary.bestScore?.toFixed(3) || "N/A"}
                      </div>
                    </div>
                  </div>

                  {/* Recommendation */}
                  <Alert>
                    <CheckCircle className="h-4 w-4" />
                    <AlertTitle>Recommendation</AlertTitle>
                    <AlertDescription>
                      {modelSelection.summary.recommendation}
                    </AlertDescription>
                  </Alert>

                  {/* Selection Details */}
                  {modelSelection.selection && (
                    <div className="space-y-2 rounded-lg border p-4">
                      <h3 className="font-semibold">Training Strategy</h3>
                      <div className="grid gap-2">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            Strategy:
                          </span>
                          <Badge>{modelSelection.selection.strategy}</Badge>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            Base Model:
                          </span>
                          <span className="font-mono text-sm">
                            {modelSelection.selection.modelId}
                          </span>
                        </div>
                        <div className="text-muted-foreground text-sm">
                          {modelSelection.selection.reason}
                        </div>
                      </div>
                    </div>
                  )}

                  {modelSelection.selectionError && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>Selection Error</AlertTitle>
                      <AlertDescription>
                        {modelSelection.selectionError}
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Training Readiness */}
          <Card>
            <CardHeader>
              <CardTitle>Training Readiness</CardTitle>
              <CardDescription>
                Current system status for training
              </CardDescription>
            </CardHeader>
            <CardContent>
              {trainingStatus && (
                <div className="space-y-4">
                  <Alert
                    variant={trainingStatus.ready ? "default" : "destructive"}
                  >
                    {trainingStatus.ready ? (
                      <CheckCircle className="h-4 w-4" />
                    ) : (
                      <Clock className="h-4 w-4" />
                    )}
                    <AlertTitle>
                      {trainingStatus.ready ? "Ready to Train" : "Not Ready"}
                    </AlertTitle>
                    <AlertDescription>{trainingStatus.reason}</AlertDescription>
                  </Alert>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="rounded border p-3">
                      <div className="text-muted-foreground text-sm">
                        Total Trajectories
                      </div>
                      <div className="font-bold text-xl">
                        {trainingStatus.stats.totalTrajectories}
                      </div>
                    </div>
                    <div className="rounded border p-3">
                      <div className="text-muted-foreground text-sm">
                        Unscored
                      </div>
                      <div className="font-bold text-xl">
                        {trainingStatus.stats.unscoredTrajectories}
                      </div>
                    </div>
                    <div className="rounded border p-3">
                      <div className="text-muted-foreground text-sm">
                        Scenario Groups
                      </div>
                      <div className="font-bold text-xl">
                        {trainingStatus.stats.scenarioGroups}
                      </div>
                    </div>
                    <div className="rounded border p-3">
                      <div className="text-muted-foreground text-sm">
                        Data Quality
                      </div>
                      <div className="font-bold text-xl">
                        {(trainingStatus.stats.dataQuality * 100).toFixed(1)}%
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Actions Tab */}
        <TabsContent value="actions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Training Actions</CardTitle>
              <CardDescription>
                Manually trigger training and other operations
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border p-4">
                <h3 className="mb-2 font-semibold">Trigger Training</h3>
                <p className="mb-4 text-muted-foreground text-sm">
                  Start a new training run. Force mode will train even if not
                  ready.
                </p>
                <div className="flex gap-2">
                  <Button
                    onClick={() => triggerTraining(false)}
                    disabled={!trainingStatus?.ready}
                  >
                    <Play className="mr-2 h-4 w-4" />
                    Trigger Training
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => triggerTraining(true)}
                    className="border-red-500 text-red-500 hover:bg-red-50"
                  >
                    <Play className="mr-2 h-4 w-4" />
                    Force Training
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border p-4">
                <h3 className="mb-2 font-semibold">Refresh Data</h3>
                <p className="mb-4 text-muted-foreground text-sm">
                  Reload all data from the server to see latest updates.
                </p>
                <Button onClick={() => fetchData()} variant="outline">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh All Data
                </Button>
              </div>

              <div className="rounded-lg border p-4">
                <h3 className="mb-2 font-semibold">Benchmark Models</h3>
                <p className="mb-4 text-muted-foreground text-sm">
                  Benchmark models that haven't been tested yet.
                </p>
                <div className="space-y-2">
                  {models
                    .filter((m) => !m.benchmarkScore && m.status === "ready")
                    .map((model) => (
                      <div
                        key={model.modelId}
                        className="flex items-center justify-between"
                      >
                        <span className="text-sm">{model.modelId}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => benchmarkModel(model.modelId)}
                        >
                          Benchmark
                        </Button>
                      </div>
                    ))}
                  {models.filter(
                    (m) => !m.benchmarkScore && m.status === "ready",
                  ).length === 0 && (
                    <div className="text-muted-foreground text-sm">
                      No models need benchmarking
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AdminStandalonePage>
  );
}
