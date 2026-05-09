/**
 * Feedback modal component for collecting user feedback.
 * Displays a glass-effect modal with name, email, and comment fields.
 */
"use client";

import { Button } from "@elizaos/cloud-ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@elizaos/cloud-ui/components/dialog";
import { Input } from "@elizaos/cloud-ui/components/input";
import { Label } from "@elizaos/cloud-ui/components/label";
import { Textarea } from "@elizaos/cloud-ui/components/textarea";
import { Loader2, MessageSquare, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

function feedbackErrorMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

interface FeedbackModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultEmail?: string;
  defaultName?: string;
}

export function FeedbackModal({
  open,
  onOpenChange,
  defaultEmail = "",
  defaultName = "",
}: FeedbackModalProps) {
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [comment, setComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!comment.trim()) {
      toast.error("Please enter your feedback");
      return;
    }

    setIsSubmitting(true);

    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, comment }),
    });

    setIsSubmitting(false);

    if (!response.ok) {
      const errorMessage = feedbackErrorMessage(await response.json());
      toast.error(errorMessage ?? "Failed to send feedback");
      return;
    }

    toast.success("Thank you for your feedback!");
    setName(defaultName);
    setEmail(defaultEmail);
    setComment("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md bg-black/80 backdrop-blur-xl border-white/10 rounded-xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white">
            <MessageSquare className="h-5 w-5 text-[#FF5800]" />
            Send Feedback
          </DialogTitle>
          <DialogDescription className="text-white/60">
            We&apos;d love to hear your thoughts on how we can improve.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="feedback-name" className="text-white/80">
              Name
            </Label>
            <Input
              id="feedback-name"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-white/5 border-white/10 text-white placeholder:text-white/40 focus-visible:border-[#FF5800] focus-visible:ring-[#FF5800]/20"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="feedback-email" className="text-white/80">
              Email
            </Label>
            <Input
              id="feedback-email"
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-white/5 border-white/10 text-white placeholder:text-white/40 focus-visible:border-[#FF5800] focus-visible:ring-[#FF5800]/20"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="feedback-comment" className="text-white/80">
              Feedback<span className="text-red-500 -ml-0.5">*</span>
            </Label>
            <Textarea
              id="feedback-comment"
              placeholder="Share your thoughts, suggestions, or report an issue..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="min-h-[120px] bg-white/5 border-white/10 text-white placeholder:text-white/40 focus-visible:border-[#FF5800] focus-visible:ring-[#FF5800]/20 resize-none"
              required
            />
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="text-white/60 hover:text-white hover:bg-white/10"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="bg-[#FF5800] hover:bg-[#FF5800]/90 text-white"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  Send Feedback
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
