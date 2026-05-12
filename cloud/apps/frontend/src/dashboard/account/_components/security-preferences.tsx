/**
 * Security preferences component displaying security and notification settings.
 * Provides links to API keys, authentication, and notification preferences.
 */
"use client";

import { BrandButton, BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { Bell, ExternalLink, Key, Lock, Shield } from "lucide-react";
import { Link } from "react-router-dom";

export function SecurityPreferences() {
  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />

      <div className="relative z-10 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Shield className="h-5 w-5 text-[#FF5800]" />
            <h3 className="text-lg font-bold text-white">Security & Preferences</h3>
          </div>
          <p className="text-sm text-white/60">
            Manage your security settings and notification preferences
          </p>
        </div>

        <div className="space-y-4">
          {/* API Keys */}
          <div className="flex items-start justify-between p-4 rounded-none border border-white/10 bg-black/40">
            <div className="flex items-start gap-3">
              <div className="rounded-none p-2 bg-blue-500/20 border border-blue-500/40">
                <Key className="h-4 w-4 text-blue-400" />
              </div>
              <div className="space-y-1">
                <p className="font-medium text-sm text-white">API Keys</p>
                <p className="text-xs text-white/60">
                  Manage your API keys for programmatic access
                </p>
              </div>
            </div>
            <Link to="/dashboard/api-keys">
              <BrandButton variant="ghost" size="sm">
                <ExternalLink className="h-4 w-4" />
              </BrandButton>
            </Link>
          </div>

          {/* Authentication */}
          <div className="flex items-start justify-between p-4 rounded-none border border-white/10 bg-black/40">
            <div className="flex items-start gap-3">
              <div className="rounded-none p-2 bg-green-500/20 border border-green-500/40">
                <Lock className="h-4 w-4 text-green-400" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-sm text-white">Two-Factor Authentication</p>
                  <span className="rounded-none border border-white/20 bg-white/10 px-2 py-0.5 text-xs text-white/70">
                    Coming Soon
                  </span>
                </div>
                <p className="text-xs text-white/60">
                  Add an extra layer of security to your account
                </p>
              </div>
            </div>
            <BrandButton variant="ghost" size="sm" disabled>
              Enable
            </BrandButton>
          </div>

          {/* Notifications */}
          <div className="flex items-start justify-between p-4 rounded-none border border-white/10 bg-black/40">
            <div className="flex items-start gap-3">
              <div className="rounded-none p-2 bg-purple-500/20 border border-purple-500/40">
                <Bell className="h-4 w-4 text-purple-400" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-sm text-white">Notification Preferences</p>
                  <span className="rounded-none border border-white/20 bg-white/10 px-2 py-0.5 text-xs text-white/70">
                    Coming Soon
                  </span>
                </div>
                <p className="text-xs text-white/60">Control how you receive updates and alerts</p>
              </div>
            </div>
            <BrandButton variant="ghost" size="sm" disabled>
              Configure
            </BrandButton>
          </div>

          {/* Divider */}
          <div className="relative py-2">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/10"></div>
            </div>
          </div>

          {/* Danger Zone */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-rose-400">Danger Zone</p>
            </div>

            <div className="p-4 rounded-none border border-rose-500/40 bg-rose-500/10">
              <div className="space-y-2">
                <p className="font-medium text-sm text-white">Delete Account</p>
                <p className="text-xs text-white/60">
                  Permanently delete your account and all associated data. This action cannot be
                  undone.
                </p>
                <BrandButton
                  variant="outline"
                  size="sm"
                  disabled
                  className="mt-2 border-rose-500/40 text-rose-400 hover:bg-rose-500/10"
                >
                  Delete Account
                </BrandButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </BrandCard>
  );
}
