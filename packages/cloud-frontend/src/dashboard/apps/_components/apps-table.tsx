/**
 * Apps table component displaying user's applications.
 * Styled to match dashboard app cards with agent card dropdown menu.
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
  AppsListView,
} from "@elizaos/ui";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { App } from "../../../lib/data/apps";

interface AppsTableProps {
  apps: App[];
}

export function AppsTable({ apps }: AppsTableProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("URL copied to clipboard");
    } catch {
      toast.error("Failed to copy URL");
    }
  };

  const handleDeleteClick = (app: App) => {
    setDeleteTarget(app);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeletingId(deleteTarget.id);
    setDeleteTarget(null);
    try {
      const response = await fetch(`/api/v1/apps/${deleteTarget.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete app");
      }

      toast.success("App deleted successfully");
      window.location.reload();
    } catch (error) {
      toast.error("Failed to delete app", {
        description:
          error instanceof Error ? error.message : "Please try again",
      });
    } finally {
      setDeletingId(null);
    }
  };

  if (apps.length === 0) {
    return null;
  }

  return (
    <>
      <AppsListView
        apps={apps}
        deletingId={deletingId}
        renderAppLink={({ app, className, children }) => (
          <Link to={`/dashboard/apps/${app.id}`} className={className}>
            {children}
          </Link>
        )}
        onCopyUrl={(app) => void handleCopyUrl(app.app_url)}
        onDeleteApp={(app) => handleDeleteClick(app as App)}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete App</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-semibold text-white">
                "{deleteTarget?.name}"
              </span>
              ? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
