@product
Feature: GNOME is well-integrated into Tails

  @not_release_blocker
  Scenario: A screenshot is taken when the PRINTSCREEN key is pressed
    Given I have started Tails from DVD without network and logged in
    And I wait 10 seconds
    And there is no screenshot in the live user's Pictures directory
    When I press the "PRINTSCREEN" key
    And GNOME offers me various screenshot options
    And I press the "Return" key
    Then a screenshot is saved to the live user's Pictures directory

  Scenario: GNOME notifications are shown to the user
    Given I have started Tails from DVD without network and logged in
    When the "Dogtail rules!" notification is sent
    Then the "Dogtail rules!" notification is shown to the user

  Scenario: I can launch various apps via GNOME Activities Overview
    # Some apps (Electrum and Persistent Storage Backup) only start when
    # a Persistent Storage is available.
    Given I have started Tails without network from a USB drive with a persistent partition enabled and logged in
    # Some apps (Tor Browser) only start when the network is plugged.
    And the network is plugged
    And Tor is ready
    And all notifications have disappeared
    When I start "Additional Software" via GNOME Activities Overview
    And I close the "tails-additional-software-config" window
    When I start "Disks" via GNOME Activities Overview
    # The close button of GNOME Disks is not accessible
    And I close the "gnome-disks" window via Alt+F4
    When I start "Console" via GNOME Activities Overview
    And I close Console
    When I start "Files" via GNOME Activities Overview
    And I close the "org.gnome.Nautilus" window
    When I start "Persistent Storage" via GNOME Activities Overview
    And I close the "tps-frontend" window
    When I start "Back Up Persistent Storage" via GNOME Activities Overview
    And I close the "zenity" window
    When I start "Pidgin" via GNOME Activities Overview
    And I close the "Pidgin" window via Alt+F4
    When I start "Thunderbird" via GNOME Activities Overview
    And I click "Start Thunderbird" in the "Thunderbird Migration" zenity dialog
    And I close the "Thunderbird" window
    When I start "Tor Browser" via GNOME Activities Overview
    And I close the "Firefox" window
    When I start "Unlock VeraCrypt Volumes" via GNOME Activities Overview
    And I close the "unlock-veracrypt-volumes" window
    When I start "Unsafe Browser" via GNOME Activities Overview
    And I close the "Firefox" window
    When I start "Secrets" via GNOME Activities Overview
    And I close the "secrets" window
