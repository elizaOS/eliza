import type { CustomMutationResult } from "../types";

import { useMutation } from "@tanstack/react-query";
import { ROUTES } from "../routes";
import { SetStateAction } from "react";

export type TextResponse = {
    text: string;
    user: string;
    attachments?: { url: string; contentType: string; title: string }[];
};

type SendMessageMutationProps = {
    text: string;
    agentId: string;
    selectedFile: File | null;
};

type Props = Required<{
    setMessages: (value: SetStateAction<TextResponse[]>) => void;
    setSelectedFile: (value: SetStateAction<File | null>) => void;
}>;

export const useSendMessageMutation = ({
    setMessages,
    setSelectedFile,
}: Props): CustomMutationResult<TextResponse[], SendMessageMutationProps> => {
    const mutation = useMutation({
        mutationFn: async ({
            text,
            agentId,
            selectedFile,
        }: SendMessageMutationProps) => {
            const formData = new FormData();
            formData.append("text", text);
            formData.append("userId", "user");
            formData.append("roomId", `default-room-${agentId}`);

            if (selectedFile) {
                formData.append("file", selectedFile);
            }

            const res = await fetch(ROUTES.sendMessage(agentId), {
                method: "POST",
                body: formData,
            });

            return res.json() as Promise<TextResponse[]>;
        },
        onSuccess: (data) => {
            setMessages((prev) => [...prev, ...data]);
            setSelectedFile(null);
        },
        onError: (error) => {
            console.error("[useSendMessageMutation]:", error);
        },
    });

    return mutation;
};
