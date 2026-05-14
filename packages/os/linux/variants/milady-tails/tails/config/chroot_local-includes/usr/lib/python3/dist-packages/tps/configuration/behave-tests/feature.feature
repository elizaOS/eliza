@tags: @requires_mountpoint @requires_mock_service
Feature: Persistent Storage Features
  Test the activation of Persistent Storage features.

  Background:
    Given an unlocked Persistent Storage with an empty config file

    Scenario: Activating a feature with bind mounts
      Given a feature with bind mounts
      When the feature is activated
      Then the feature is active
      And the bind mounts are active

    Scenario: Activating a feature with inconsistent state
      Given a feature with bind mounts
      And the feature is not active
      And the bind mounts are not active
      But the feature is enabled in the config file
      When the feature is activated
      Then the feature is active
      And the bind mounts are active

    Scenario: Deactivating a feature with inconsistent state
      Given a feature with bind mounts
      And the feature is active
      And the bind mounts are active
      But the feature is not enabled in the config file
      When the feature is deactivated
      Then the feature is not active
      And the bind mounts are not active

    Scenario: Deleting a feature
      Given a feature with a bind mount
      And the feature is not active
      And the source directory exists
      And the source directory contains a file owned by amnesia
      When the feature is deleted
      Then the source directory does not exist
