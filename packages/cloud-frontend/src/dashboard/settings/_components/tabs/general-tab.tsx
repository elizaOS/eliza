/**
 * General settings tab component for user profile and notification preferences.
 * Allows users to update their name, nickname, work function, preferences, and notification settings.
 *
 * @param props - General tab configuration
 * @param props.user - User data with organization information
 */

"use client";

import {
  BrandCard,
  CornerBrackets,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from "@elizaos/ui";
import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/providers/I18nProvider";
import type { UserWithOrganizationDto } from "@/types/cloud-api";

interface GeneralTabProps {
  user: UserWithOrganizationDto;
}

interface FormState {
  fullName: string;
  nickname: string;
  workFunction: string;
  preferences: string;
  responseNotifications: boolean;
  emailNotifications: boolean;
  saving: boolean;
}

export function GeneralTab({ user }: GeneralTabProps) {
  const t = useT();
  const [formState, setFormState] = useState<FormState>({
    fullName: user.name || "",
    nickname: user.nickname || "",
    workFunction: user.work_function || "",
    preferences: user.preferences || "",
    responseNotifications: user.response_notifications ?? true,
    emailNotifications: user.email_notifications ?? true,
    saving: false,
  });

  const updateForm = (updates: Partial<FormState>) => {
    setFormState((prev) => ({ ...prev, ...updates }));
  };

  const handleSave = async () => {
    if (formState.saving) return;
    updateForm({ saving: true });

    const response = await fetch("/api/v1/user", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formState.fullName,
        nickname: formState.nickname,
        work_function: formState.workFunction,
        preferences: formState.preferences,
        response_notifications: formState.responseNotifications,
        email_notifications: formState.emailNotifications,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(
        data.error ||
          t("cloud.generalTab.saveFailed", {
            defaultValue: "Failed to save settings",
          }),
      );
    }

    toast.success(
      t("cloud.generalTab.saveSuccess", {
        defaultValue: "Settings saved successfully",
      }),
    );
    window.location.reload();
    updateForm({ saving: false });
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      {/* Profile Information Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-4 md:space-y-6">
          {/* Full Name and Nickname Row */}
          <div className="flex flex-col md:flex-row gap-4 w-full">
            {/* Full Name */}
            <div className="flex-1 space-y-2">
              <Label className="text-white font-mono text-sm md:text-base">
                {t("cloud.generalTab.fullName", { defaultValue: "Full name" })}
              </Label>
              <div className="flex gap-2">
                {/* Avatar */}
                <div className="flex items-center justify-center bg-[rgba(255,88,0,0.25)] px-2 py-2 min-w-[36px]">
                  <span className="text-white text-sm font-normal">
                    {getInitials(formState.fullName || "DR")}
                  </span>
                </div>
                {/* Input */}
                <Input
                  value={formState.fullName}
                  onChange={(e) => updateForm({ fullName: e.target.value })}
                  className="flex-1 bg-transparent border-[#303030] text-white"
                  placeholder={t("cloud.generalTab.fullNamePlaceholder", {
                    defaultValue: "Enter your full name",
                  })}
                />
              </div>
            </div>

            {/* Nickname */}
            <div className="flex-1 space-y-2">
              <Label className="text-white font-mono text-sm md:text-base">
                {t("cloud.generalTab.nicknameLabel", {
                  defaultValue: "What should we call you?",
                })}
              </Label>
              <Input
                value={formState.nickname}
                onChange={(e) => updateForm({ nickname: e.target.value })}
                className="bg-transparent border-[#303030] text-white"
                placeholder="Diogo"
              />
            </div>
          </div>

          {/* Work Function */}
          <div className="space-y-2">
            <Label className="text-white font-mono text-sm md:text-base">
              {t("cloud.generalTab.workFunctionLabel", {
                defaultValue: "What best describes your work?",
              })}
            </Label>
            <Select
              value={formState.workFunction}
              onValueChange={(v) => updateForm({ workFunction: v })}
            >
              <SelectTrigger className="bg-transparent border-[#303030] text-white data-[placeholder]:text-white/60">
                <SelectValue
                  placeholder={t("cloud.generalTab.workFunctionPlaceholder", {
                    defaultValue: "Select your work function",
                  })}
                />
              </SelectTrigger>
              <SelectContent className="bg-[#1a1a1a] border-[#303030]">
                <SelectItem value="developer">
                  {t("cloud.generalTab.workDeveloper", {
                    defaultValue: "Software Developer",
                  })}
                </SelectItem>
                <SelectItem value="designer">
                  {t("cloud.generalTab.workDesigner", {
                    defaultValue: "Designer",
                  })}
                </SelectItem>
                <SelectItem value="product">
                  {t("cloud.generalTab.workProduct", {
                    defaultValue: "Product Manager",
                  })}
                </SelectItem>
                <SelectItem value="data">
                  {t("cloud.generalTab.workData", {
                    defaultValue: "Data Scientist",
                  })}
                </SelectItem>
                <SelectItem value="marketing">
                  {t("cloud.generalTab.workMarketing", {
                    defaultValue: "Marketing",
                  })}
                </SelectItem>
                <SelectItem value="sales">
                  {t("cloud.generalTab.workSales", { defaultValue: "Sales" })}
                </SelectItem>
                <SelectItem value="other">
                  {t("cloud.generalTab.workOther", { defaultValue: "Other" })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Personal Preferences */}
          <div className="space-y-2">
            <Label className="text-white font-mono text-sm md:text-base">
              {t("cloud.generalTab.preferencesLabel", {
                defaultValue:
                  "What personal preferences should Eliza consider in responses?",
              })}
            </Label>
            <p className="text-xs text-[#858585] font-mono">
              {t("cloud.generalTab.preferencesIntro", {
                defaultValue:
                  "Your preferences will apply to all conversations, within",
              })}{" "}
              <span className="underline cursor-pointer hover:text-white transition-colors">
                {t("cloud.generalTab.elizasGuidelines", {
                  defaultValue: "Eliza's guidelines",
                })}
              </span>
              .{" "}
              <span className="underline cursor-pointer hover:text-white transition-colors">
                {t("cloud.generalTab.learnAboutPreferences", {
                  defaultValue: "Learn about preferences.",
                })}
              </span>
            </p>
            <Textarea
              value={formState.preferences}
              onChange={(e) => updateForm({ preferences: e.target.value })}
              className="bg-transparent border-[#303030] text-white min-h-[80px] resize-none"
              placeholder={t("cloud.generalTab.preferencesPlaceholder", {
                defaultValue:
                  "e.g. when learning new concepts, I find analogies particularly helpful",
              })}
            />
          </div>

          {/* Save Button */}
          <button
            type="button"
            onClick={handleSave}
            disabled={formState.saving}
            className="relative bg-[#e1e1e1] px-4 py-2.5 overflow-hidden group hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed w-full md:w-auto"
          >
            {/* Pattern overlay */}
            <div
              className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
              style={{
                backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                backgroundSize: "2.915576934814453px 2.915576934814453px",
              }}
            />
            <span className="relative z-10 text-black font-mono font-medium text-sm md:text-base whitespace-nowrap">
              {formState.saving
                ? t("cloud.generalTab.saving", { defaultValue: "Saving..." })
                : t("cloud.generalTab.saveChanges", {
                    defaultValue: "Save changes",
                  })}
            </span>
          </button>
        </div>
      </BrandCard>

      {/* Response Completions Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-4 md:space-y-6">
          {/* Response Completions */}
          <div className="space-y-2">
            <Label className="text-white font-mono text-sm md:text-base">
              {t("cloud.generalTab.responseCompletions", {
                defaultValue: "Response completions",
              })}
            </Label>
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <p className="text-xs text-[#858585] font-mono max-w-2xl">
                {t("cloud.generalTab.responseCompletionsDesc", {
                  defaultValue:
                    "Get notiified when Eliza has finished a response. Most useful for long-running tasks like too calls, and research.",
                })}
              </p>
              <Switch
                checked={formState.responseNotifications}
                onCheckedChange={(checked) =>
                  updateForm({ responseNotifications: checked })
                }
                className="data-[state=checked]:bg-[#FF5800] flex-shrink-0"
              />
            </div>
          </div>

          {/* Email Notifications */}
          <div className="space-y-2">
            <Label className="text-white font-mono text-sm md:text-base">
              {t("cloud.generalTab.emailsFromEliza", {
                defaultValue: "Emails from Eliza",
              })}
            </Label>
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <p className="text-xs text-[#858585] font-mono max-w-2xl">
                {t("cloud.generalTab.emailsFromElizaDesc", {
                  defaultValue:
                    "Get an email when Eliza has finished building or needs your response.",
                })}
              </p>
              <Switch
                checked={formState.emailNotifications}
                onCheckedChange={(checked) =>
                  updateForm({ emailNotifications: checked })
                }
                className="data-[state=checked]:bg-[#FF5800] flex-shrink-0"
              />
            </div>
          </div>
        </div>
      </BrandCard>
    </div>
  );
}
