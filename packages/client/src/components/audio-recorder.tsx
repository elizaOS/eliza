import React, { useEffect, useMemo, useRef, useState } from "react";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Ellipsis, Mic, Send, Trash } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useMutation } from "@tanstack/react-query";
import type { UUID } from "@elizaos/core";
import { apiClient } from "@/lib/api";

type Props = {
    agentId: UUID;
    onChange: (newInput: string) => void;
    className?: string;
    timerClassName?: string;
};

type Record = {
    id: number;
    name: string;
    file: string | null;
};

let recorder: MediaRecorder;
let recordingChunks: BlobPart[] = [];
let timerTimeout: NodeJS.Timeout;

// Utility function to pad a number with leading zeros
const padWithLeadingZeros = (num: number, length: number): string => {
    return String(num).padStart(length, "0");
};

export const AudioRecorder = ({
    className,
    timerClassName,
    agentId,
    onChange,
}: Props) => {
    const { toast } = useToast();
    // States
    const [isRecording, setIsRecording] = useState<boolean>(false);
    const [_, setIsRecordingFinished] =
        useState<boolean>(false);
    const [timer, setTimer] = useState<number>(0);
    const [currentRecord, setCurrentRecord] = useState<Record>({
        id: -1,
        name: "",
        file: null,
    });
    // Calculate the hours, minutes, and seconds from the timer
    const minutes = Math.floor((timer % 3600) / 60);
    const seconds = timer % 60;

    const [minuteLeft, minuteRight] = useMemo(
        () => padWithLeadingZeros(minutes, 2).split(""),
        [minutes]
    );
    const [secondLeft, secondRight] = useMemo(
        () => padWithLeadingZeros(seconds, 2).split(""),
        [seconds]
    );
    // Refs
    const mediaRecorderRef = useRef<{
        stream: MediaStream | null;
        analyser: AnalyserNode | null;
        mediaRecorder: MediaRecorder | null;
        audioContext: AudioContext | null;
    }>({
        stream: null,
        analyser: null,
        mediaRecorder: null,
        audioContext: null,
    });

    const mutation = useMutation({
        mutationKey: ["whisper"],
        mutationFn: (file: Blob) => apiClient.whisper(agentId, file),
        onSuccess: (data: { text: string }) => {
            if (data?.text) {
                onChange(data.text);
            }
        },
        onError: (e) => {
            toast({
                variant: "destructive",
                title: "Unable to start recording",
                description: e.message,
            });
            console.log(e);
        },
    });

    function startRecording() {
        if (navigator.mediaDevices?.getUserMedia) {
            navigator.mediaDevices
                .getUserMedia({
                    audio: true,
                })
                .then((stream) => {
                    setIsRecording(true);
                    // ============ Analyzing ============
                    const AudioContext = window.AudioContext;
                    const audioCtx = new AudioContext();
                    const analyser = audioCtx.createAnalyser();
                    const source = audioCtx.createMediaStreamSource(stream);
                    source.connect(analyser);
                    mediaRecorderRef.current = {
                        stream,
                        analyser,
                        mediaRecorder: null,
                        audioContext: audioCtx,
                    };

                    const mimeType = MediaRecorder.isTypeSupported("audio/mpeg")
                        ? "audio/mpeg"
                        : MediaRecorder.isTypeSupported("audio/webm")
                          ? "audio/webm"
                          : "audio/wav";

                    const options = { mimeType };
                    mediaRecorderRef.current.mediaRecorder = new MediaRecorder(
                        stream,
                        options
                    );
                    mediaRecorderRef.current.mediaRecorder.start();
                    recordingChunks = [];
                    // ============ Recording ============
                    recorder = new MediaRecorder(stream);
                    recorder.start();
                    recorder.ondataavailable = (e) => {
                        recordingChunks.push(e.data);
                    };
                })
                .catch((e) => {
                    toast({
                        variant: "destructive",
                        title: "Unable to start recording",
                        description: e.message,
                    });
                    console.log(e);
                });
        }
    }
    function stopRecording() {
        recorder.onstop = () => {
            const recordBlob = new Blob(recordingChunks, {
                type: "audio/wav",
            });
            mutation.mutate(recordBlob);
            setCurrentRecord({
                ...currentRecord,
                file: window.URL.createObjectURL(recordBlob),
            });
            recordingChunks = [];
        };

        recorder.stop();

        setIsRecording(false);
        setIsRecordingFinished(true);
        setTimer(0);
        clearTimeout(timerTimeout);
    }
    function resetRecording() {
        const { mediaRecorder, stream, analyser, audioContext } =
            mediaRecorderRef.current;

        if (mediaRecorder) {
            mediaRecorder.onstop = () => {
                recordingChunks = [];
            };
            mediaRecorder.stop();
        }

        // Stop the web audio context and the analyser node
        if (analyser) {
            analyser.disconnect();
        }
        if (stream) {
            for (const track of stream.getTracks()) {
                track.stop();
            }
        }
        if (audioContext) {
            audioContext.close();
        }
        setIsRecording(false);
        setIsRecordingFinished(true);
        setTimer(0);
        clearTimeout(timerTimeout);
    }
    const handleSubmit = () => {
        stopRecording();
    };

    // Effect to update the timer every second
    useEffect(() => {
        if (isRecording) {
            timerTimeout = setTimeout(() => {
                setTimer(timer + 1);
            }, 1000);
        }
        return () => clearTimeout(timerTimeout);
    }, [isRecording, timer]);

    if (mutation?.isPending) {
        return (
            <Button variant="ghost" disabled size="icon">
                <Ellipsis className="size-4" />
            </Button>
        );
    }

    return (
        <div
            className={cn(
                "flex items-center justify-center gap-2 border-l border-l-transparent border-opacity-0 transition-all duration-300",
                {
                    "border-opacity-100 border-l-border pl-2": isRecording,
                },
                className
            )}
        >
            {isRecording ? (
                <div className="flex gap-1 items-center">
                    <div className="bg-red-500 rounded-full h-2.5 w-2.5 animate-pulse" />
                    <Timer
                        minuteLeft={minuteLeft}
                        minuteRight={minuteRight}
                        secondLeft={secondLeft}
                        secondRight={secondRight}
                        timerClassName={timerClassName}
                    />
                </div>
            ) : null}

            <div className="flex items-center">
                {/* ========== Delete recording button ========== */}
                {isRecording ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                onClick={resetRecording}
                                size={"icon"}
                                variant="ghost"
                            >
                                <Trash className="size-4" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent className="m-2">
                            <span> Reset recording</span>
                        </TooltipContent>
                    </Tooltip>
                ) : null}

                {/* ========== Start and send recording button ========== */}
                <Tooltip>
                    <TooltipTrigger asChild>
                        {!isRecording ? (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => startRecording()}
                            >
                                <Mic className="size-4" />
                                <span className="sr-only">Use Microphone</span>
                            </Button>
                        ) : (
                            <Button
                                onClick={handleSubmit}
                                variant="ghost"
                                size="icon"
                            >
                                <Send className="size-4" />
                            </Button>
                        )}
                    </TooltipTrigger>
                    <TooltipContent side="right">
                        <span>{!isRecording ? "Start" : "Send"} </span>
                    </TooltipContent>
                </Tooltip>
            </div>
        </div>
    );
};

const Timer = React.memo(
    ({
        minuteLeft,
        minuteRight,
        secondLeft,
        secondRight,
        timerClassName,
    }: {
        minuteLeft: string;
        minuteRight: string;
        secondLeft: string;
        secondRight: string;
        timerClassName?: string;
    }) => {
        return (
            <div
                className={cn(
                    "text-sm animate-in duration-1000 fade-in-0 select-none",
                    timerClassName
                )}
            >
                <p>
                    {minuteLeft}
                    {minuteRight}:{secondLeft}
                    {secondRight}
                </p>
            </div>
        );
    }
);

Timer.displayName = "Timer";
