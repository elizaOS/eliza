/**
 * API tester component for testing API endpoints interactively.
 * Supports request/response testing, audio input, parameter configuration,
 * response visualization, and credit cost display.
 *
 * @param props - API tester configuration
 * @param props.endpoint - API endpoint configuration to test
 * @param props.authToken - Authentication token for API requests
 * @param props.refreshCredits - Optional callback to refresh credit balance after request
 */

"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@elizaos/cloud-ui";
import {
  CheckIcon,
  CodeIcon,
  Coins,
  CopyIcon,
  FileAudioIcon,
  Info,
  LoaderIcon,
  MicIcon,
  PlayIcon,
  Sparkles,
  StopCircleIcon,
  Trash2Icon,
  TrendingUp,
  UploadIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getApiBaseUrl } from "@/lib/config/client-env";
import { type ApiEndpoint, formatEndpointPrice } from "@/lib/swagger/endpoint-discovery";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/utils/toast-adapter";
import { useAudioRecorder } from "../../../components/chat/hooks/use-audio-recorder";
import { CodeDisplay } from "./code-display";
import { CustomSelect } from "./custom-select";

interface ApiTesterProps {
  endpoint: ApiEndpoint;
  authToken: string;
  isAuthLoading?: boolean;
  refreshCredits?: () => void;
}

interface TestResponse {
  success: boolean;
  status: number;
  statusText: string;
  data?: unknown;
  error?: string;
  headers: Record<string, string>;
  responseTime: number;
  timestamp: string;
}

interface AudioResponseData {
  _type?: string;
  _audioUrl?: string;
  _size?: number;
  message?: string;
}

export function ApiTester({
  endpoint,
  authToken,
  isAuthLoading = false,
  refreshCredits,
}: ApiTesterProps) {
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<TestResponse | null>(null);
  const [activeTab, setActiveTab] = useState("parameters");
  const [recordedAudio, setRecordedAudio] = useState<Blob | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);

  // Audio recorder hook for STT endpoint
  const audioRecorder = useAudioRecorder();

  const initializeParameters = useCallback(() => {
    if (!endpoint) return;

    const defaultParams: Record<string, unknown> = {};

    if (endpoint.parameters?.body) {
      endpoint.parameters.body.forEach((param) => {
        defaultParams[param.name] = param.defaultValue || param.example || "";
      });
    }

    if (endpoint.parameters?.query) {
      endpoint.parameters.query.forEach((param) => {
        defaultParams[param.name] = param.defaultValue || param.example || "";
      });
    }

    if (endpoint.parameters?.path) {
      endpoint.parameters.path.forEach((param) => {
        defaultParams[param.name] = param.defaultValue || param.example || "";
      });
    }

    setParameters(defaultParams);
  }, [endpoint]);

  useEffect(() => {
    initializeParameters();
  }, [initializeParameters]);

  const handleParameterChange = (name: string, value: unknown) => {
    setParameters((prev) => ({ ...prev, [name]: value }));
  };

  // Handle file upload for voice cloning
  const handleFileUpload = (files: FileList | null) => {
    if (!files) return;

    const fileArray = Array.from(files);
    const audioFiles = fileArray.filter((file) => file.type.startsWith("audio/"));

    if (audioFiles.length === 0) {
      toast({
        message: "Please upload audio files only",
        mode: "error",
      });
      return;
    }

    // Limit to 10 files total
    const currentCount = uploadedFiles.length;
    const newFiles = audioFiles.slice(0, Math.max(0, 10 - currentCount));

    if (newFiles.length < audioFiles.length) {
      toast({
        message: "Maximum 10 audio files allowed",
        mode: "info",
      });
    }

    setUploadedFiles((prev) => [...prev, ...newFiles]);
  };

  const removeFile = (index: number) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const executeTest = async () => {
    if (endpoint.requiresAuth && isAuthLoading) {
      toast({
        message: "Loading API key...",
        mode: "info",
      });
      return;
    }

    if (endpoint.requiresAuth && !authToken.trim()) {
      toast({
        message: "API key is required for this endpoint",
        mode: "error",
      });
      return;
    }

    if (endpoint.requiresAuth && authToken.trim()) {
      const isValidFormat = authToken.startsWith("eliza_") || authToken.startsWith("sk-");
      if (!isValidFormat) {
        toast({
          message: "Invalid API key format. Must start with eliza_ or sk-",
          mode: "error",
        });
        return;
      }
    }

    // Check if this is STT endpoint and we have recorded audio
    const isSTTEndpoint = endpoint.path === "/api/elevenlabs/stt";
    if (isSTTEndpoint && !recordedAudio && !audioRecorder.audioBlob) {
      toast({
        message: "Please record audio first",
        mode: "error",
      });
      return;
    }

    // Check if this is voice cloning endpoint and we have uploaded files
    const isVoiceCloneEndpoint = endpoint.path === "/api/elevenlabs/voices/clone";
    if (isVoiceCloneEndpoint && uploadedFiles.length === 0) {
      toast({
        message: "Please upload at least one audio file",
        mode: "error",
      });
      return;
    }

    setIsLoading(true);
    setResponse(null);
    const startTime = Date.now();

    try {
      const baseUrl = getApiBaseUrl();
      let url = `${baseUrl}${endpoint.path}`;

      if (endpoint.parameters?.path) {
        endpoint.parameters.path.forEach((param) => {
          if (parameters[param.name]) {
            url = url.replace(
              `{${param.name}}`,
              encodeURIComponent(String(parameters[param.name])),
            );
          }
        });
      }

      if (endpoint.parameters?.query) {
        const queryParams = new URLSearchParams();
        endpoint.parameters.query.forEach((param) => {
          if (parameters[param.name] !== undefined && parameters[param.name] !== "") {
            queryParams.append(param.name, String(parameters[param.name]));
          }
        });
        if (queryParams.toString()) {
          url += `?${queryParams.toString()}`;
        }
      }

      const headers: Record<string, string> = {};

      if (endpoint.requiresAuth && authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
      }

      let body: string | FormData | undefined;

      // Handle STT endpoint with multipart/form-data
      if (isSTTEndpoint) {
        const formData = new FormData();
        const audioBlob = recordedAudio || audioRecorder.audioBlob;
        if (audioBlob) {
          formData.append("audio", audioBlob, "recording.webm");
        }
        if (parameters.languageCode) {
          formData.append("languageCode", String(parameters.languageCode));
        }
        body = formData;
        // Don't set Content-Type for FormData - browser will set it with boundary
      } else if (isVoiceCloneEndpoint) {
        // Handle voice cloning endpoint with multipart/form-data
        const formData = new FormData();

        // Add text parameters
        if (parameters.name) {
          formData.append("name", String(parameters.name));
        }
        if (parameters.description) {
          formData.append("description", String(parameters.description));
        }
        if (parameters.cloneType) {
          formData.append("cloneType", String(parameters.cloneType));
        }
        if (parameters.settings) {
          formData.append("settings", String(parameters.settings));
        }

        // Add uploaded audio files
        uploadedFiles.forEach((file, index) => {
          formData.append(`file${index}`, file);
        });

        body = formData;
        // Don't set Content-Type for FormData - browser will set it with boundary
      } else {
        // Regular JSON body for other endpoints
        headers["Content-Type"] = "application/json";
        if (endpoint.method !== "GET" && endpoint.parameters?.body) {
          const bodyData: Record<string, unknown> = {};
          endpoint.parameters.body.forEach((param) => {
            const value = parameters[param.name];

            if ((value !== undefined && value !== "") || param.required) {
              if (param.type === "object" || param.type === "array") {
                try {
                  const parsedValue = typeof value === "string" ? JSON.parse(value) : value;
                  bodyData[param.name] = parsedValue;
                } catch {
                  if (param.required) {
                    toast({
                      message: `Invalid JSON for ${param.name}. Please check the format.`,
                      mode: "error",
                    });
                    throw new Error(`Invalid JSON for required parameter: ${param.name}`);
                  }
                  bodyData[param.name] = value;
                }
              } else if (param.type === "number") {
                bodyData[param.name] = Number(value);
              } else if (param.type === "boolean") {
                bodyData[param.name] = Boolean(value);
              } else {
                bodyData[param.name] = value;
              }
            }
          });
          body = JSON.stringify(bodyData);
        }
      }

      const fetchResponse = await fetch(url, {
        method: endpoint.method,
        headers,
        body,
      });

      const responseTime = Date.now() - startTime;
      const responseHeaders: Record<string, string> = {};
      fetchResponse.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let responseData;
      const contentType = fetchResponse.headers.get("content-type");

      // Handle audio responses (TTS endpoint)
      if (contentType?.includes("audio/")) {
        const blob = await fetchResponse.blob();
        const audioUrl = URL.createObjectURL(blob);
        responseData = {
          _type: "audio",
          _audioUrl: audioUrl,
          _contentType: contentType,
          _size: blob.size,
          message: "Audio file received successfully",
        };
      } else if (contentType?.includes("application/json")) {
        responseData = await fetchResponse.json();
      } else {
        responseData = await fetchResponse.text();
      }

      interface ErrorResponse {
        error?: { message?: string };
        message?: string;
      }

      const errorData = responseData as ErrorResponse;
      const errorMessage = fetchResponse.ok
        ? undefined
        : errorData?.error?.message || errorData?.message || "Request failed";

      setResponse({
        success: fetchResponse.ok,
        status: fetchResponse.status,
        statusText: fetchResponse.statusText,
        data: responseData,
        error: errorMessage,
        headers: responseHeaders,
        responseTime,
        timestamp: new Date().toISOString(),
      });

      if (fetchResponse.ok) {
        toast({ message: "Request successful!", mode: "success" });
        setActiveTab("response");

        if (refreshCredits) {
          const creditConsumingEndpoints = [
            "/api/v1/generate-image",
            "/api/v1/generate-video",
            "/api/v1/chat",
          ];

          if (creditConsumingEndpoints.includes(endpoint.path)) {
            setTimeout(() => {
              refreshCredits();
            }, 1000);
          }
        }
      } else {
        toast({ message: "Request failed", mode: "error" });
        setActiveTab("response");
      }
    } catch (error) {
      const responseTime = Date.now() - startTime;
      setResponse({
        success: false,
        status: 0,
        statusText: "Network Error",
        error: error instanceof Error ? error.message : "Unknown error",
        headers: {},
        responseTime,
        timestamp: new Date().toISOString(),
      });
      toast({ message: "Network error occurred", mode: "error" });
      setActiveTab("response");
    } finally {
      setIsLoading(false);
    }
  };

  const generateCurlCommand = () => {
    const baseUrl = getApiBaseUrl();
    let url = `${baseUrl}${endpoint.path}`;

    if (endpoint.parameters?.path) {
      endpoint.parameters.path.forEach((param) => {
        if (parameters[param.name]) {
          url = url.replace(`{${param.name}}`, encodeURIComponent(String(parameters[param.name])));
        }
      });
    }

    if (endpoint.parameters?.query) {
      const queryParams = new URLSearchParams();
      endpoint.parameters.query.forEach((param) => {
        if (parameters[param.name] !== undefined && parameters[param.name] !== "") {
          queryParams.append(param.name, String(parameters[param.name]));
        }
      });
      if (queryParams.toString()) {
        url += `?${queryParams.toString()}`;
      }
    }

    let command = `curl -X ${endpoint.method} "${url}"`;

    if (endpoint.requiresAuth && authToken) {
      command += ` \\\n  -H "Authorization: Bearer ${authToken}"`;
    }

    if (endpoint.method !== "GET") {
      command += ` \\\n  -H "Content-Type: application/json"`;
    }

    if (endpoint.method !== "GET" && endpoint.parameters?.body) {
      const bodyData: Record<string, unknown> = {};
      endpoint.parameters.body.forEach((param) => {
        const value = parameters[param.name];
        if (value !== undefined && value !== "") {
          bodyData[param.name] = value;
        }
      });

      if (Object.keys(bodyData).length > 0) {
        command += ` \\\n  -d '${JSON.stringify(bodyData, null, 2)}'`;
      }
    }

    return command;
  };

  const copyCurlCommand = async () => {
    const command = generateCurlCommand();
    await navigator.clipboard.writeText(command);
    toast({ message: "cURL command copied to clipboard", mode: "success" });
  };

  const renderParameterInput = (
    param: {
      name: string;
      type: string;
      required: boolean;
      description: string;
      example?: unknown;
      enum?: string[];
      format?: string;
      defaultValue?: unknown;
    },
    value: unknown,
  ) => {
    const inputId = `param-${param.name}`;

    return (
      <div key={param.name} className="space-y-2">
        <Label htmlFor={inputId} className="flex items-center gap-2">
          {param.name}
          {param.required && <span className="text-red-500">*</span>}
          <Badge variant="outline" className="text-xs">
            {param.type}
          </Badge>
        </Label>

        <p className="text-sm text-muted-foreground">{param.description}</p>

        {param.enum ? (
          <CustomSelect
            value={String(value || "")}
            onValueChange={(v) => handleParameterChange(param.name, v)}
            options={param.enum.map((option: string) => ({
              value: option,
              label: option,
            }))}
            placeholder={`Select ${param.name}`}
          />
        ) : param.type === "boolean" ? (
          <div className="flex items-center space-x-2">
            <Checkbox
              id={inputId}
              checked={Boolean(value || false)}
              onCheckedChange={(checked) => handleParameterChange(param.name, checked)}
            />
            <Label htmlFor={inputId} className="text-sm">
              Enable {param.name}
            </Label>
          </div>
        ) : param.type === "number" ? (
          <Input
            id={inputId}
            type="number"
            value={String(value || "")}
            onChange={(e) => handleParameterChange(param.name, Number(e.target.value))}
            placeholder={param.example?.toString()}
          />
        ) : param.type === "object" || param.type === "array" ? (
          <Textarea
            id={inputId}
            value={
              typeof value === "string"
                ? value
                : JSON.stringify(value || param.defaultValue || param.example, null, 2)
            }
            onChange={(e) => handleParameterChange(param.name, e.target.value)}
            placeholder={JSON.stringify(param.defaultValue || param.example, null, 2)}
            rows={4}
            className="font-mono"
          />
        ) : (
          <Input
            id={inputId}
            type={param.format === "password" ? "password" : "text"}
            value={String(value || "")}
            onChange={(e) => handleParameterChange(param.name, e.target.value)}
            placeholder={param.example?.toString()}
          />
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Pricing Information Card */}
      {endpoint.pricing && (
        <Card className="border-border/60 bg-background/60 rounded-none overflow-hidden">
          <div
            className={`h-1 w-full ${endpoint.pricing.isFree ? "bg-emerald-500" : endpoint.pricing.isVariable ? "bg-amber-500" : "bg-[#FF5800]"}`}
          />
          <CardContent className="pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div
                  className={`p-2.5 rounded-lg ${endpoint.pricing.isFree ? "bg-emerald-500/10" : endpoint.pricing.isVariable ? "bg-amber-500/10" : "bg-[#FF5800]/10"}`}
                >
                  {endpoint.pricing.isFree ? (
                    <Sparkles className={`h-5 w-5 text-emerald-400`} />
                  ) : endpoint.pricing.isVariable ? (
                    <TrendingUp className={`h-5 w-5 text-amber-400`} />
                  ) : (
                    <Coins className={`h-5 w-5 text-[#FF5800]`} />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xl font-bold ${endpoint.pricing.isFree ? "text-emerald-400" : endpoint.pricing.isVariable ? "text-amber-400" : "text-[#FF5800]"}`}
                    >
                      {formatEndpointPrice(endpoint.pricing)}
                    </span>
                    {!endpoint.pricing.isFree && (
                      <span className="text-sm text-muted-foreground">
                        per {endpoint.pricing.unit}
                      </span>
                    )}
                  </div>
                  {endpoint.pricing.description && (
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {endpoint.pricing.description}
                    </p>
                  )}
                </div>
              </div>
              {endpoint.pricing.isVariable && !endpoint.pricing.isFree && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-500/10 border border-amber-500/20 rounded-md">
                  <Info className="h-3.5 w-3.5 text-amber-400" />
                  <span className="text-xs text-amber-400 font-medium">Variable pricing</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          onClick={executeTest}
          disabled={isLoading || (endpoint.requiresAuth && isAuthLoading)}
          className="gap-2 bg-[#471E08] text-[#FF5800] hover:bg-[#5A2610] active:bg-[#6B2E18] border-0"
        >
          {isLoading ? (
            <LoaderIcon className="h-4 w-4 animate-spin" />
          ) : (
            <PlayIcon className="h-4 w-4" />
          )}
          {isLoading
            ? "Testing..."
            : endpoint.requiresAuth && isAuthLoading
              ? "Loading API key..."
              : "Send Request"}
        </Button>

        <Button variant="outline" onClick={copyCurlCommand} className="gap-2 sm:w-auto">
          <CodeIcon className="h-4 w-4" />
          Copy cURL
        </Button>

        <Button variant="ghost" onClick={initializeParameters} className="sm:w-auto">
          Reset
        </Button>
      </div>

      <Tabs id="api-tester-tabs" value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4 w-full justify-start">
          <TabsTrigger value="parameters">Parameters</TabsTrigger>
          <TabsTrigger value="response">
            Response
            {response && (
              <Badge variant={response.success ? "default" : "destructive"} className="ml-2">
                {response.status}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="curl">cURL</TabsTrigger>
        </TabsList>

        <TabsContent value="parameters" className="space-y-6">
          {/* Audio Recorder for STT Endpoint */}
          {endpoint.path === "/api/elevenlabs/stt" && (
            <Card className="border-border/60 bg-background/60 rounded-none">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <MicIcon className="h-5 w-5" />
                  Audio Recording
                </CardTitle>
                <CardDescription>Record audio to transcribe using Speech-to-Text</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {audioRecorder.error && (
                    <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-none text-sm text-red-800 dark:text-red-400">
                      {audioRecorder.error}
                    </div>
                  )}

                  <div className="flex items-center gap-4">
                    {!audioRecorder.isRecording && !audioRecorder.audioBlob && !recordedAudio && (
                      <Button onClick={audioRecorder.startRecording} className="gap-2">
                        <MicIcon className="h-4 w-4" />
                        Start Recording
                      </Button>
                    )}

                    {audioRecorder.isRecording && (
                      <>
                        <Button
                          onClick={audioRecorder.stopRecording}
                          variant="destructive"
                          className="gap-2"
                        >
                          <StopCircleIcon className="h-4 w-4" />
                          Stop Recording
                        </Button>
                        <Badge variant="secondary" className="text-sm">
                          Recording: {audioRecorder.recordingTime}s
                        </Badge>
                      </>
                    )}

                    {(audioRecorder.audioBlob || recordedAudio) && (
                      <>
                        <Badge variant="outline" className="text-sm">
                          ✅ Audio Ready
                        </Badge>
                        <audio
                          controls
                          className="h-10"
                          src={
                            recordedAudio
                              ? URL.createObjectURL(recordedAudio)
                              : audioRecorder.audioBlob
                                ? URL.createObjectURL(audioRecorder.audioBlob)
                                : undefined
                          }
                        >
                          <track kind="captions" />
                        </audio>
                        <Button
                          onClick={() => {
                            setRecordedAudio(null);
                            audioRecorder.clearRecording();
                          }}
                          variant="ghost"
                          size="sm"
                          className="gap-2"
                        >
                          <Trash2Icon className="h-4 w-4" />
                          Clear
                        </Button>
                      </>
                    )}
                  </div>

                  {(audioRecorder.audioBlob || recordedAudio) && (
                    <div className="text-sm text-muted-foreground">
                      Audio recorded successfully. Click &quot;Send Request&quot; to transcribe.
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* File Upload for Voice Cloning Endpoint */}
          {endpoint.path === "/api/elevenlabs/voices/clone" && (
            <Card className="border-border/60 bg-background/60 rounded-none">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <UploadIcon className="h-5 w-5" />
                  Audio Sample Upload
                </CardTitle>
                <CardDescription>
                  Upload 1-10 audio samples for voice cloning (max 100MB total)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="border-2 border-dashed border-border/60 rounded-none p-6 hover:border-primary/50 transition-colors">
                    <input
                      type="file"
                      accept="audio/*"
                      multiple
                      onChange={(e) => handleFileUpload(e.target.files)}
                      className="hidden"
                      id="audio-file-upload"
                    />
                    <label
                      htmlFor="audio-file-upload"
                      className="flex flex-col items-center gap-3 cursor-pointer"
                    >
                      <UploadIcon className="h-12 w-12 text-muted-foreground/60" />
                      <div className="text-center">
                        <p className="text-sm font-medium">Click to upload audio files</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          MP3, WAV, M4A, WebM, OGG (max 100MB total)
                        </p>
                      </div>
                    </label>
                  </div>

                  {uploadedFiles.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">
                          Uploaded Files ({uploadedFiles.length}/10)
                        </Label>
                        <Button
                          onClick={() => setUploadedFiles([])}
                          variant="ghost"
                          size="sm"
                          className="gap-2 text-xs"
                        >
                          <Trash2Icon className="h-3 w-3" />
                          Clear All
                        </Button>
                      </div>

                      <div className="space-y-2">
                        {uploadedFiles.map((file, index) => (
                          <div
                            key={index}
                            className="flex items-center justify-between p-3 bg-muted/50 rounded-none border border-border/40"
                          >
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                              <FileAudioIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{file.name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {(file.size / 1024).toFixed(2)} KB
                                </p>
                              </div>
                            </div>
                            <Button
                              onClick={() => removeFile(index)}
                              variant="ghost"
                              size="sm"
                              className="gap-1 flex-shrink-0"
                            >
                              <XCircleIcon className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>

                      <div className="text-xs text-muted-foreground">
                        Total size:{" "}
                        {(
                          uploadedFiles.reduce((acc, file) => acc + file.size, 0) /
                          1024 /
                          1024
                        ).toFixed(2)}{" "}
                        MB / 100 MB
                      </div>
                    </div>
                  )}

                  {uploadedFiles.length === 0 && (
                    <div className="text-sm text-muted-foreground">
                      No files uploaded yet. Please upload at least 1 audio sample.
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {endpoint.parameters?.path && endpoint.parameters.path.length > 0 && (
            <Card className="border-border/60 bg-background/60 rounded-none">
              <CardHeader>
                <CardTitle className="text-lg">Path Parameters</CardTitle>
                <CardDescription>Parameters that are part of the URL path</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {endpoint.parameters.path.map((param) =>
                    renderParameterInput(param, parameters[param.name]),
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {endpoint.parameters?.query && endpoint.parameters.query.length > 0 && (
            <Card className="border-border/60 bg-background/60 rounded-none">
              <CardHeader>
                <CardTitle className="text-lg">Query Parameters</CardTitle>
                <CardDescription>Parameters added to the URL query string</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {endpoint.parameters.query.map((param) =>
                    renderParameterInput(param, parameters[param.name]),
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {endpoint.parameters?.body &&
            endpoint.parameters.body.length > 0 &&
            // Hide for STT since we use recorder
            endpoint.path !== "/api/elevenlabs/stt" && (
              <Card className="border-border/60 bg-background/60 rounded-none">
                <CardHeader>
                  <CardTitle className="text-lg">Request Body</CardTitle>
                  <CardDescription>
                    {endpoint.path === "/api/elevenlabs/voices/clone"
                      ? "Voice settings and metadata (audio files uploaded above)"
                      : "JSON payload sent with the request"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {endpoint.parameters.body
                      .filter(
                        (param) =>
                          // Skip file parameters for voice cloning endpoint
                          !(
                            endpoint.path === "/api/elevenlabs/voices/clone" &&
                            param.name.startsWith("file")
                          ),
                      )
                      .map((param) => renderParameterInput(param, parameters[param.name]))}
                  </div>
                </CardContent>
              </Card>
            )}

          {!endpoint.parameters?.path?.length &&
            !endpoint.parameters?.query?.length &&
            !endpoint.parameters?.body?.length && (
              <Card className="border-border/60 bg-background/60 rounded-none">
                <CardContent className="py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    This endpoint doesn&apos;t require any parameters.
                  </p>
                </CardContent>
              </Card>
            )}
        </TabsContent>

        <TabsContent value="response">
          {response ? (
            <div className="space-y-4">
              <Card className="border-border/60 bg-background/60 rounded-none">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      {response.success ? (
                        <CheckIcon className="h-5 w-5 text-green-500" />
                      ) : (
                        <XIcon className="h-5 w-5 text-red-500" />
                      )}
                      Response
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge
                        className={cn(
                          "rounded-none px-2.5 py-1 text-xs font-medium",
                          response.success
                            ? "bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-300"
                            : "bg-rose-500/10 text-rose-600 ring-1 ring-inset ring-rose-500/30 dark:text-rose-300",
                        )}
                      >
                        {response.status} {response.statusText}
                      </Badge>
                      <Badge variant="outline" className="rounded-none">
                        {response.responseTime}ms
                      </Badge>
                    </div>
                  </div>
                </CardHeader>

                {response.error && (
                  <CardContent>
                    <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-none">
                      <p className="text-red-800 dark:text-red-400 font-medium">
                        Error: {response.error}
                      </p>
                    </div>
                  </CardContent>
                )}
              </Card>

              {response.data !== undefined && (
                <Card className="border-border/60 bg-background/60 rounded-none">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle>Response Body</CardTitle>
                      {(response.data as AudioResponseData)?._type !== "audio" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-2"
                          onClick={() => {
                            navigator.clipboard.writeText(formatResponseData(response.data));
                            toast({
                              message: "Response copied to clipboard",
                              mode: "success",
                            });
                          }}
                        >
                          <CopyIcon className="h-4 w-4" />
                          Copy
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    {(() => {
                      const audioData = response.data as AudioResponseData;
                      return audioData?._type === "audio" ? (
                        <div className="space-y-4">
                          <div className="rounded-none border border-border/60 bg-muted/30 p-4">
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline" className="text-xs">
                                  Audio Response
                                </Badge>
                                <Badge variant="secondary" className="text-xs">
                                  {((audioData?._size || 0) / 1024).toFixed(2)} KB
                                </Badge>
                              </div>
                              <p className="text-sm text-muted-foreground">{audioData?.message}</p>
                              <audio controls className="w-full mt-4" src={audioData?._audioUrl}>
                                <track kind="captions" />
                              </audio>
                              <div className="flex gap-2 mt-4">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    const audioUrl = audioData?._audioUrl;
                                    if (audioUrl) {
                                      const a = document.createElement("a");
                                      a.href = audioUrl;
                                      a.download = "audio.mp3";
                                      document.body.appendChild(a);
                                      a.click();
                                      document.body.removeChild(a);
                                      toast({
                                        message: "Audio downloaded",
                                        mode: "success",
                                      });
                                    }
                                  }}
                                >
                                  Download Audio
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <ScrollArea className="h-[400px] w-full">
                          <CodeDisplay code={formatResponseData(response.data)} language="json" />
                        </ScrollArea>
                      );
                    })()}
                  </CardContent>
                </Card>
              )}

              <Card className="border-border/60 bg-background/60 rounded-none">
                <CardHeader>
                  <CardTitle>Response Headers</CardTitle>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-64 w-full rounded-none border border-border/60">
                    <div className="min-w-0">
                      <dl className="divide-y divide-border/60 text-sm">
                        {Object.entries(response.headers).map(([key, value]) => (
                          <div key={key} className="flex flex-col gap-1 px-4 py-3 min-w-0">
                            <dt className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                              {key}
                            </dt>
                            <dd className="font-mono text-sm text-foreground break-all overflow-wrap-anywhere">
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card className="border-border/60 bg-background/60 rounded-none">
              <CardContent className="py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  No response yet. Send a request to see the results.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="curl">
          <Card className="border-border/60 bg-background/60 rounded-none">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>cURL Command</CardTitle>
                <Button variant="outline" size="sm" className="gap-2" onClick={copyCurlCommand}>
                  <CopyIcon className="h-4 w-4" />
                  Copy
                </Button>
              </div>
              <CardDescription>
                Copy this command to test the API from your terminal
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CodeDisplay code={generateCurlCommand()} language="bash" />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function formatResponseData(data: unknown): string {
  if (data === null || data === undefined) {
    return "";
  }

  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return data;
    }
  }

  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}
