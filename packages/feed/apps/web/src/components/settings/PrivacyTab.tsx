'use client';

import { logger } from '@babylon/shared';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { apiFetch } from '@/utils/api-fetch';

export function PrivacyTab() {
  const { user, logout } = useAuth();
  const [isExporting, setIsExporting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const handleExportData = async () => {
    setIsExporting(true);

    const response = await apiFetch('/api/users/export-data');

    if (!response.ok) {
      setIsExporting(false);
      toast.error('Failed to export data. Please try again.');
      return;
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `babylon-data-export-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    toast.success('Data exported successfully');
    logger.info('User exported their data', undefined, 'PrivacyTab');
    setIsExporting(false);
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmation !== 'DELETE MY ACCOUNT') {
      toast.error('Please type the confirmation text exactly');
      return;
    }

    setIsDeleting(true);

    const response = await apiFetch('/api/users/delete-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmation: 'DELETE MY ACCOUNT',
        reason: deleteReason || undefined,
      }),
    });

    if (!response.ok) {
      setIsDeleting(false);
      toast.error(
        'Failed to delete account. Please try again or contact support.'
      );
      return;
    }

    toast.success('Account deleted successfully');
    logger.info('User deleted their account', undefined, 'PrivacyTab');

    setTimeout(async () => {
      await logout();
      window.location.href = '/';
    }, 2000);
    setIsDeleting(false);
  };

  return (
    <div className="space-y-6">
      {/* Legal Documents */}
      <div className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="font-semibold">Legal Documents</h3>
        <div className="space-y-2">
          <a
            href="https://docs.babylon.market/legal/privacy-policy/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-primary text-sm hover:underline"
          >
            <ExternalLink className="h-4 w-4" />
            Privacy Policy
          </a>
          <a
            href="https://docs.babylon.market/legal/terms-of-service/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-primary text-sm hover:underline"
          >
            <ExternalLink className="h-4 w-4" />
            Terms of Service
          </a>
        </div>
        {user?.tosAcceptedAt && (
          <p className="text-muted-foreground text-xs">
            You accepted the Terms of Service on{' '}
            {new Date(user.tosAcceptedAt).toLocaleDateString()}
          </p>
        )}
      </div>

      {/* Data Export */}
      <div className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="font-semibold">Download Your Data</h3>
        <p className="text-muted-foreground text-sm">
          Export all your personal data, including profile information, posts,
          comments, trading history, and more. This is your right under GDPR
          Article 15 (Right to Access) and CCPA.
        </p>
        <button
          onClick={handleExportData}
          disabled={isExporting}
          className="rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isExporting ? 'Exporting...' : 'Export My Data'}
        </button>
        <p className="text-muted-foreground text-xs">
          You will receive a JSON file containing all your data.
        </p>
      </div>

      {/* Account Deletion */}
      <div className="space-y-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
        <h3 className="font-semibold text-red-500">Delete Your Account</h3>
        <p className="text-muted-foreground text-sm">
          Permanently delete your account and personal data. This action cannot
          be undone. This is your right under GDPR Article 17 (Right to Erasure)
          and CCPA.
        </p>

        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="rounded-lg bg-red-500 px-4 py-2 text-primary-foreground hover:bg-red-600"
          >
            Delete My Account
          </button>
        ) : (
          <div className="space-y-3 rounded-lg border border-border bg-background p-4">
            <div className="space-y-2">
              <label className="font-medium text-sm">
                Reason for deletion (optional):
              </label>
              <textarea
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="Help us improve by telling us why you're leaving..."
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <label className="font-medium text-sm">
                Type{' '}
                <code className="rounded bg-muted px-2 py-1">
                  DELETE MY ACCOUNT
                </code>{' '}
                to confirm:
              </label>
              <input
                type="text"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
                placeholder="DELETE MY ACCOUNT"
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
              />
            </div>

            <div className="space-y-1 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">
              <p className="font-semibold text-red-500">
                Warning: This action is irreversible
              </p>
              <ul className="list-inside list-disc space-y-1 text-muted-foreground">
                <li>
                  Your account and personal data will be permanently deleted
                </li>
                <li>All your posts, comments, and content will be removed</li>
                <li>Your trading history and positions will be deleted</li>
                <li>Some anonymized data may be retained for analytics</li>
              </ul>
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleDeleteAccount}
                disabled={
                  isDeleting || deleteConfirmation !== 'DELETE MY ACCOUNT'
                }
                className="rounded-lg bg-red-500 px-4 py-2 text-primary-foreground hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : 'Confirm Deletion'}
              </button>
              <button
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmation('');
                  setDeleteReason('');
                }}
                disabled={isDeleting}
                className="rounded-lg bg-muted px-4 py-2 text-foreground hover:bg-muted/80"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Contact Information */}
      <div className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="font-semibold">Privacy Questions?</h3>
        <p className="text-muted-foreground text-sm">
          For privacy-related inquiries, data subject requests, or to exercise
          your rights, contact us at:
        </p>
        <a
          href="mailto:babylon@elizalabs.ai"
          className="text-primary text-sm hover:underline"
        >
          babylon@elizalabs.ai
        </a>
        <p className="text-muted-foreground text-xs">
          We will respond to verified requests within 30 days (45 days for
          complex requests) as required by GDPR and CCPA.
        </p>
      </div>
    </div>
  );
}
