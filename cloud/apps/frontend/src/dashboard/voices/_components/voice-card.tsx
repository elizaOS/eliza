/**
 * Voice card component displaying voice clone information and actions.
 * Supports preview playback, deletion, and navigation to voice details.
 *
 * @param props - Voice card configuration
 * @param props.voice - Voice data to display
 * @param props.onDelete - Callback when voice is deleted
 * @param props.onPreview - Callback when preview button is clicked
 */

"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@elizaos/cloud-ui";
import { formatDistanceToNow } from "date-fns";
import { ExternalLink, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import type { Voice } from "@elizaos/cloud-ui";

interface VoiceCardProps {
  voice: Voice;
  onDelete: (voiceId: string) => void;
  onPreview: (voice: Voice) => void;
}

export function VoiceCard({ voice, onDelete, onPreview }: VoiceCardProps) {
  const navigate = useNavigate();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    const response = await fetch(`/api/elevenlabs/voices/${voice.id}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error("Failed to delete voice");
    }

    toast.success("Voice deleted successfully");
    onDelete(voice.id);
    setIsDeleteDialogOpen(false);
    setIsDeleting(false);
  };

  const handleUseInTTS = () => {
    // Navigate to text page with voice selected
    navigate(`/dashboard/chat?voiceId=${voice.elevenlabsVoiceId}`);
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "N/A";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <>
      <Card className="hover:shadow-md transition-shadow">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <CardTitle className="truncate">{voice.name}</CardTitle>
              <CardDescription className="line-clamp-2 mt-1">
                {voice.description || "No description"}
              </CardDescription>
            </div>
            <Badge
              variant={voice.cloneType === "instant" ? "default" : "secondary"}
              className="ml-2 shrink-0"
            >
              {voice.cloneType === "instant" ? "Instant" : "Professional"}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Stats Grid */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Usage</p>
              <p className="font-medium">{voice.usageCount} times</p>
            </div>
            <div>
              <p className="text-muted-foreground">Samples</p>
              <p className="font-medium">{voice.sampleCount} files</p>
            </div>
            {voice.audioQualityScore && (
              <div>
                <p className="text-muted-foreground">Quality</p>
                <p className="font-medium">{voice.audioQualityScore}/10</p>
              </div>
            )}
            {voice.totalAudioDurationSeconds && (
              <div>
                <p className="text-muted-foreground">Duration</p>
                <p className="font-medium">{formatDuration(voice.totalAudioDurationSeconds)}</p>
              </div>
            )}
          </div>

          {/* Metadata */}
          <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
            <p>
              Created{" "}
              {formatDistanceToNow(new Date(voice.createdAt), {
                addSuffix: true,
              })}
            </p>
            {voice.lastUsedAt && (
              <p>
                Last used{" "}
                {formatDistanceToNow(new Date(voice.lastUsedAt), {
                  addSuffix: true,
                })}
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => onPreview(voice)} className="flex-1">
              <Play className="mr-2 h-4 w-4" />
              Preview
            </Button>
            <Button variant="default" size="sm" onClick={handleUseInTTS} className="flex-1">
              <ExternalLink className="mr-2 h-4 w-4" />
              Use in TTS
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsDeleteDialogOpen(true)}
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Voice Clone?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{voice.name}&quot;? This action cannot be undone
              and the voice will be permanently removed from both Eliza Cloud and ElevenLabs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete Voice"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
