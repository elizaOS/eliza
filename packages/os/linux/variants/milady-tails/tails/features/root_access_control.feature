@product
Feature: Root access control enforcement
  As a Tails user, I can perform administrative tasks only by using
  the password I have optionally set up in the Welcome Screen

  Scenario: I can perform administrative tasks if I have set up an administration password in the Welcome Screen
    Given I have started Tails from DVD without network and logged in with an administration password
    And running a command as root with pkexec requires PolicyKit administrator privileges
    Then I can run a command as root with sudo
    Then I can run a command as root with pkexec

  Scenario: I cannot perform administrative tasks unless I have set up an administration password in the Welcome Screen
    Given I have started Tails from DVD without network and logged in
    And running a command as root with pkexec requires PolicyKit administrator privileges
    Then I cannot run a command as root with sudo and the standard passwords
    And I cannot run a command as root with pkexec and the standard passwords
    Then I cannot login as root using su with the standard passwords
