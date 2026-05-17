@product
Feature: User gets actionable info about UEFI CA expiry
  As a Tails user
  When I'm using a computer which has Secure Boot, but doesn't have the Microsoft 2023 CA
  Then I get a notification telling me what to do

    Scenario: I am warned about UEFI CA expiry
        Given I have started Tails from DVD without network and stopped at Tails Greeter's login screen
        And I simulate a computer with old UEFI CA
        And I log in to a new session
        And all notifications have disappeared
        And I unblock tails-uefi-ca-notify
        Then I see the "Secure Boot Update Needed" notification after at most 20 seconds
        And I can open the Secure Boot documentation from the notification

    Scenario: I am not warned if the UEFI CA is up-to-date
        Given I have started Tails from DVD without network and stopped at Tails Greeter's login screen
        And I simulate a computer with new UEFI CA
        And I log in to a new session
        And all notifications have disappeared
        And I unblock tails-uefi-ca-notify
        Then I wait until amnesia's tails-uefi-ca-notify-user.service has completed
        And I don't see the "Secure Boot Update Needed" notification after at most 10 seconds
