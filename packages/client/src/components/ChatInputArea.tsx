import React, { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ChatInput } from '@/components/ui/chat/chat-input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AudioRecorder } from '@/components/audio-recorder';
import { Loader2, Paperclip, Send, FileText, X } from 'lucide-react';
import type { Agent, UUID } from '@elizaos/core';
import type { UploadingFile } from '@/hooks/use-file-upload';

interface ChatInputAreaProps {
    input: string;
    setInput: (value: string) => void;
    inputDisabled: boolean;
    selectedFiles: UploadingFile[];
    removeFile: (fileId: string) => void;
    handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    handleSendMessage: (e: React.FormEvent<HTMLFormElement>) => void;
    handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    chatType: 'DM' | 'GROUP';
    targetAgentData?: Agent;
    formRef: React.RefObject<HTMLFormElement | null>;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
    fileInputRef: React.RefObject<HTMLInputElement | null>;
}

export const ChatInputArea: React.FC<ChatInputAreaProps> = ({
    input,
    setInput,
    inputDisabled,
    selectedFiles,
    removeFile,
    handleFileChange,
    handleSendMessage,
    handleKeyDown,
    chatType,
    targetAgentData,
    formRef,
    inputRef,
    fileInputRef,
}) => {
    return (
        <div className="px-4 pb-4 mt-auto flex-shrink-0">
            {inputDisabled && (
                <div className="px-2 pb-2 text-sm text-muted-foreground flex items-center gap-2">
                    <div className="flex gap-0.5 items-center justify-center">
                        <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0s]" />
                        <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0.2s]" />
                        <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0.4s]" />
                    </div>
                    <span>{chatType === 'DM' && targetAgentData ? `${targetAgentData.name} is thinking` : 'Agent is thinking'}</span>
                    <div className="flex">
                        <span className="animate-pulse [animation-delay:0ms]">.</span>
                        <span className="animate-pulse [animation-delay:200ms]">.</span>
                        <span className="animate-pulse [animation-delay:400ms]">.</span>
                    </div>
                </div>
            )}
            <form
                ref={formRef}
                onSubmit={handleSendMessage}
                className="relative rounded-md border bg-card"
            >
                {selectedFiles.length > 0 && (
                    <div className="flex flex-wrap gap-3 p-3 pb-0">
                        {selectedFiles.map((fileData) => {
                            const blobUrl = fileData.blobUrl || URL.createObjectURL(fileData.file);

                            return (
                                <div key={fileData.id} className="relative p-2">
                                    <div className="relative w-16 h-16 rounded-lg overflow-hidden border bg-muted">
                                        {fileData.isUploading && (
                                            <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-10">
                                                <Loader2 className="h-4 w-4 animate-spin text-white" />
                                            </div>
                                        )}
                                        {fileData.file.type.startsWith('image/') ? (
                                            <img
                                                alt="Selected file"
                                                src={blobUrl}
                                                className="w-full h-full object-cover"
                                            />
                                        ) : fileData.file.type.startsWith('video/') ? (
                                            <video
                                                src={blobUrl}
                                                className="w-full h-full object-cover"
                                                muted
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center bg-muted">
                                                <FileText className="h-8 w-8 text-muted-foreground" />
                                            </div>
                                        )}
                                        {fileData.error && (
                                            <div className="absolute bottom-0 left-0 right-0 bg-red-500 text-white text-xs p-1 text-center">
                                                Error
                                            </div>
                                        )}
                                    </div>
                                    <Button
                                        onClick={() => removeFile(fileData.id)}
                                        className="absolute -right-1 -top-1 size-[20px] ring-2 ring-background z-20"
                                        variant="outline"
                                        size="icon"
                                        disabled={fileData.isUploading}
                                    >
                                        <X className="h-3 w-3" />
                                    </Button>
                                    <div className="text-xs text-center mt-1 truncate w-16">
                                        {fileData.file.name}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
                <ChatInput
                    ref={inputRef}
                    onKeyDown={handleKeyDown}
                    value={input}
                    onChange={({ target }) => setInput(target.value)}
                    placeholder={
                        inputDisabled
                            ? chatType === 'DM' && targetAgentData
                                ? `${targetAgentData.name} is thinking...`
                                : 'Agent is processing...'
                            : chatType === 'DM'
                                ? 'Type your message here...'
                                : 'Message group...'
                    }
                    className="min-h-12 resize-none rounded-md bg-card border-0 p-3 shadow-none focus-visible:ring-0"
                    disabled={inputDisabled || (chatType === 'DM' && targetAgentData?.status === 'inactive')}
                />
                <div className="flex items-center p-3 pt-0">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => {
                                        if (fileInputRef.current) fileInputRef.current.click();
                                    }}
                                >
                                    <Paperclip className="size-4" />
                                    <span className="sr-only">Attach file</span>
                                </Button>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    onChange={handleFileChange}
                                    accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.rtf,..."
                                    multiple
                                    className="hidden"
                                />
                            </div>
                        </TooltipTrigger>
                        <TooltipContent side="left">
                            <p>Attach files</p>
                        </TooltipContent>
                    </Tooltip>
                    {chatType === 'DM' && targetAgentData?.id && (
                        <AudioRecorder
                            agentId={targetAgentData.id}
                            onChange={(newInput: string) => setInput(newInput)}
                        />
                    )}
                    <Button
                        disabled={
                            inputDisabled ||
                            (chatType === 'DM' && targetAgentData?.status === 'inactive') ||
                            selectedFiles.some((f) => f.isUploading)
                        }
                        type="submit"
                        size="sm"
                        className="ml-auto gap-1.5 h-[30px]"
                    >
                        {inputDisabled || selectedFiles.some((f) => f.isUploading) ? (
                            <div className="flex gap-0.5 items-center justify-center">
                                <span className="w-[4px] h-[4px] bg-gray-500 rounded-full animate-bounce [animation-delay:0s]" />
                                <span className="w-[4px] h-[4px] bg-gray-500 rounded-full animate-bounce [animation-delay:0.2s]" />
                                <span className="w-[4px] h-[4px] bg-gray-500 rounded-full animate-bounce [animation-delay:0.4s]" />
                            </div>
                        ) : (
                            <Send className="size-3.5" />
                        )}
                    </Button>
                </div>
            </form>
        </div>
    );
}; 