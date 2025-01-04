import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TextResponse } from "@/api";
import { useSendMessageMutation } from "@/api";
import { ImageIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import "./App.css";

export default function Chat() {
    const { agentId } = useParams();
    const [input, setInput] = useState("");
    const [messages, setMessages] = useState<TextResponse[]>([]);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const { mutate: sendMessage, isPending } = useSendMessageMutation({ setMessages, setSelectedFile });

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if ((!input.trim() && !selectedFile) || !agentId) return;

        // Add user message immediately to state
        const userMessage: TextResponse = {
            text: input,
            user: "user",
            attachments: selectedFile ? [{ url: URL.createObjectURL(selectedFile), contentType: selectedFile.type, title: selectedFile.name }] : undefined,
        };
        setMessages((prev) => [...prev, userMessage]);

        sendMessage({ text: input, agentId, selectedFile });
        setInput("");
    };

    const handleFileSelect = () => {
        fileInputRef.current?.click();
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file && file.type.startsWith('image/')) {
            setSelectedFile(file);
        }
    };

    return (
        <div className="flex flex-col h-screen max-h-screen w-full">
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
                <div className="max-w-3xl mx-auto space-y-4">
                    {messages.length > 0 ? (
                        messages.map((message, index) => (
                            <div
                                key={index}
                                className={`text-left flex ${
                                    message.user === "user"
                                        ? "justify-end"
                                        : "justify-start"
                                }`}
                            >
                                <pre
                                    className={`max-w-[80%] rounded-lg px-4 py-2 whitespace-pre-wrap ${
                                        message.user === "user"
                                            ? "bg-primary text-primary-foreground"
                                            : "bg-muted"
                                    }`}
                                >
                                    {message.text}
                                    {message.attachments?.map((attachment, i) => (
                                        attachment.contentType.startsWith('image/') && (
                                            <img
                                                key={i}
                                                src={message.user === "user"
                                                    ? attachment.url
                                                    : attachment.url.startsWith('http')
                                                        ? attachment.url
                                                        : `http://localhost:3000/media/generated/${attachment.url.split('/').pop()}`
                                                }
                                                alt={attachment.title || "Attached image"}
                                                className="mt-2 max-w-full rounded-lg"
                                            />
                                        )
                                    ))}
                                 </pre>
                            </div>
                        ))
                    ) : (
                        <div className="text-center text-muted-foreground">
                            No messages yet. Start a conversation!
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>
            </div>

            <div className="border-t p-4 bg-background">
                <div className="max-w-3xl mx-auto">
                    <form onSubmit={handleSubmit} className="flex gap-2">
                        <input
                            type="file"
                            ref={fileInputRef}
                            onChange={handleFileChange}
                            accept="image/*"
                            className="hidden"
                        />
                        <Input
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Type a message..."
                            className="flex-1"
                            disabled={isPending}
                        />
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={handleFileSelect}
                            disabled={isPending}
                        >
                            <ImageIcon className="h-4 w-4" />
                        </Button>
                        <Button type="submit" disabled={isPending}>
                            {isPending ? "..." : "Send"}
                        </Button>
                    </form>
                    {selectedFile && (
                        <div className="mt-2 text-sm text-muted-foreground">
                            Selected file: {selectedFile.name}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
