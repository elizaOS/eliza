"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@elizaos/cloud-ui";
import { ArrowRight, Lock, Mail, Sparkles } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

interface EmailCaptureModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (email: string) => Promise<void>;
  onSkip: () => void;
  characterName: string;
  isLoading?: boolean;
}

export function EmailCaptureModal({
  open,
  onClose,
  onSubmit,
  onSkip,
  characterName,
  isLoading = false,
}: EmailCaptureModalProps) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (!email || !email.includes("@")) {
      toast.error("Please enter a valid email address");
      return;
    }

    setSubmitting(true);

    // Hand off to Steward login; login can pre-fill `email`. Parent `onSubmit`
    // runs first so it can stash anon merge / analytics / returnTo context.
    await onSubmit(email);

    const returnTo =
      typeof window !== "undefined" ? `${window.location.pathname}${window.location.search}` : "/";
    const params = new URLSearchParams({ returnTo, email });
    navigate(`/login?${params.toString()}`);
    setSubmitting(false);
  }

  function handleSkipClick() {
    onSkip();
    toast.info("Starting anonymous session. Sign up later to save your chat!");
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 mx-auto mb-4">
            <Sparkles className="w-6 h-6 text-primary" />
          </div>
          <DialogTitle className="text-center text-2xl">One last thing...</DialogTitle>
          <DialogDescription className="text-center text-base">
            Enter your email to save your conversation with {characterName} and access it from any
            device.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6 mt-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email address</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="pl-10"
                disabled={submitting || isLoading}
                required
              />
            </div>
          </div>

          <div className="space-y-2 bg-muted/50 rounded-lg p-4">
            <p className="text-sm font-medium">What you get:</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <ArrowRight className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />
                <span>Save and access your chat history forever</span>
              </li>
              <li className="flex items-start gap-2">
                <ArrowRight className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />
                <span>Continue conversations from any device</span>
              </li>
              <li className="flex items-start gap-2">
                <ArrowRight className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />
                <span>Unlock unlimited messages</span>
              </li>
            </ul>
          </div>

          {/* Action Buttons */}
          <div className="space-y-3">
            <Button type="submit" className="w-full" size="lg" disabled={submitting || isLoading}>
              {submitting || isLoading ? (
                <>
                  <span className="animate-spin mr-2">⏳</span>
                  Creating your account...
                </>
              ) : (
                <>
                  Continue to Chat
                  <ArrowRight className="w-4 h-4 ml-2" />
                </>
              )}
            </Button>

            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={handleSkipClick}
              disabled={submitting || isLoading}
            >
              Skip for now
            </Button>
          </div>

          {/* Privacy Notice */}
          <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg p-3">
            <Lock className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <p>
              We&apos;ll never spam you or share your email. It&apos;s only used to save your chat
              and send you important updates.
            </p>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
