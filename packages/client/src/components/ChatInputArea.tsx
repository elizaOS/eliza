import React, { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ChatInput } from '@/components/ui/chat/chat-input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AudioRecorder } from '@/components/audio-recorder';
import { Loader2, Paperclip, Send, FileText, X } from 'lucide-react';
import { Agent, UUID, ChannelType } from '@elizaos/core';
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
  chatType: ChannelType.DM | ChannelType.GROUP;
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
    <div className="px-2 sm:px-4 pb-2 sm:pb-4 mt-auto flex-shrink-0" data-testid="chat-container">
      {inputDisabled && (
        <div className="px-2 pb-2 text-sm text-muted-foreground flex items-center gap-2">
          <div className="flex gap-0.5 items-center justify-center">
            <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0s]" />
            <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0.2s]" />
            <span className="w-[6px] h-[6px] bg-white rounded-full animate-bounce [animation-delay:0.4s]" />
          </div>
          <span className="text-xs sm:text-sm">
            {chatType === ChannelType.DM && targetAgentData
              ? `${targetAgentData.name} is thinking`
              : 'Agent is thinking'}
          </span>
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
        className="relative rounded-md border bg-card p-2 sm:p-3"
      >
        {selectedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 sm:gap-3 p-2 sm:p-3 pb-0 max-h-32 sm:max-h-40 overflow-y-auto">
            {selectedFiles.map((fileData) => {
              const blobUrl = fileData.blobUrl || URL.createObjectURL(fileData.file);

              return (
                <div key={fileData.id} className="relative p-1 sm:p-2">
                  <div className="relative w-12 h-12 sm:w-16 sm:h-16 rounded-lg overflow-hidden border bg-muted">
                    {fileData.isUploading && (
                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-10">
                        <Loader2 className="h-3 w-3 sm:h-4 sm:w-4 animate-spin text-white" />
                      </div>
                    )}
                    {fileData.file.type.startsWith('image/') ? (
                      <img
                        alt="Selected file"
                        src={blobUrl}
                        className="w-full h-full object-cover"
                      />
                    ) : fileData.file.type.startsWith('video/') ? (
                      <video src={blobUrl} className="w-full h-full object-cover" muted />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-muted">
                        <FileText className="h-4 w-4 sm:h-8 sm:w-8 text-muted-foreground" />
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
                    className="absolute -right-1 -top-1 size-[16px] sm:size-[20px] ring-2 ring-background z-20"
                    variant="outline"
                    size="icon"
                    disabled={fileData.isUploading}
                  >
                    <X className="h-2 w-2 sm:h-3 sm:w-3" />
                  </Button>
                  <div className="text-xs text-center mt-1 truncate w-12 sm:w-16">
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
              ? chatType === ChannelType.DM && targetAgentData
                ? `${targetAgentData.name} is thinking...`
                : 'Agent is processing...'
              : chatType === ChannelType.DM
                ? 'Type your message here...'
                : 'Message group...'
          }
          className="min-h-12 resize-none rounded-none bg-card border-0 px-0 py-0 shadow-none focus-visible:ring-0 text-sm sm:text-base"
          disabled={
            inputDisabled || (chatType === ChannelType.DM && targetAgentData?.status === 'inactive')
          }
          data-testid="chat-input"
        />
        <div className="flex items-center pt-0 gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 sm:h-10 sm:w-10"
                  onClick={() => {
                    if (fileInputRef.current) fileInputRef.current.click();
                  }}
                >
                  <Paperclip className="size-3 sm:size-4" />
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
          {chatType === ChannelType.DM && targetAgentData?.id && (
            <AudioRecorder
              agentId={targetAgentData.id}
              onChange={(newInput: string) => setInput(newInput)}
            />
          )}
          <Button
            disabled={
              inputDisabled ||
              (chatType === ChannelType.DM && targetAgentData?.status === 'inactive') ||
              selectedFiles.some((f) => f.isUploading)
            }
            type="submit"
            size="sm"
            className="ml-auto gap-1.5 h-[26px] sm:h-[30px] px-2 sm:px-3"
            data-testid="send-button"
          >
            {inputDisabled || selectedFiles.some((f) => f.isUploading) ? (
              <div className="flex gap-0.5 items-center justify-center">
                <span className="w-[4px] h-[4px] bg-gray-500 rounded-full animate-bounce [animation-delay:0s]" />
                <span className="w-[4px] h-[4px] bg-gray-500 rounded-full animate-bounce [animation-delay:0.2s]" />
                <span className="w-[4px] h-[4px] bg-gray-500 rounded-full animate-bounce [animation-delay:0.4s]" />
              </div>
            ) : (
              <Send className="size-3 sm:size-3.5" />
            )}
          </Button>
        </div>
      </form>
    </div>
  );
};
