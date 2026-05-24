@product
Feature: Using Secrets

  Scenario: I can easily access kdbx files in /home/amnesia/Persistent
    Given I have started Tails without network from a USB drive with a persistent partition and stopped at Tails Greeter's login screen
    And I enable persistence
    And I write a file "/home/amnesia/Persistent/Passwords.kdbx" with contents ""
    And I change ownership of file "/home/amnesia/Persistent/Passwords.kdbx" to "amnesia:"
    And I log in to a new session
    When I start "Secrets" via GNOME Activities Overview
    Then Secrets tries to open "/home/amnesia/Persistent/Passwords.kdbx"

  Scenario: I can open kdbx files in Secrets
    Given I have started Tails from DVD without network and logged in
    And I have a "MyPass.kdbx" file in my home
    When I start "Files" via GNOME Activities Overview
    And I open "MyPass.kdbx" in Files
    Then Secrets tries to open "/home/amnesia/MyPass.kdbx"
