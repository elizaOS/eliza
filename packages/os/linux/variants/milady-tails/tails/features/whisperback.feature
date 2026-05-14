@product
Feature: I can report a bug with WhisperBack
  As a Tails user
  When I experience a bug in Tails
  I want to send a complete bug report to the Tails team

  # Anti-test: tails-debugging-info is not available to amnesia
  Scenario: The amnesia user cannot run tails-debugging-info as root
    Given I have started Tails from DVD without network and logged in
    Then running "sudo /usr/local/sbin/tails-debugging-info" as user "amnesia" fails

  Scenario: All debugging information can be retrieved
    Given I have started Tails from DVD without network and logged in
    Then running "/usr/local/sbin/tails-debugging-info --strict" as user "root" succeeds

  Scenario: WhisperBack has access to debugging information
    Given I have started Tails from DVD without network and logged in
    When I start "WhisperBack" via GNOME Activities Overview
    Then WhisperBack has debugging information
