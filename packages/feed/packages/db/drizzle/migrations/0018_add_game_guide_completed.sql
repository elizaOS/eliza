-- Add gameGuideCompletedAt column to User table
-- Tracks when a user completed the game onboarding guide (5-slide tutorial)
-- NULL means user has not completed the guide yet

ALTER TABLE "User" ADD COLUMN "gameGuideCompletedAt" TIMESTAMP;
