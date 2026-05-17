@product @not_release_blocker
Feature: Using VeraCrypt encrypted volumes
  In order to collaborate with non-Tails users
  As a Tails user
  I want to unlock VeraCrypt encrypted volumes

  Background:
    Given I have started Tails from DVD without network and logged in

### Unlock VeraCrypt Volumes

  Scenario: Use Unlock VeraCrypt Volumes to unlock a USB drive that has a basic VeraCrypt volume
    When I plug a USB drive containing a basic VeraCrypt volume
    And I cancel the GNOME authentication prompt
    And I unlock and mount this VeraCrypt volume with Unlock VeraCrypt Volumes
    And I open this VeraCrypt volume in GNOME Files
    Then I see the expected contents in this VeraCrypt volume
    When I lock the currently opened VeraCrypt volume
    Then the VeraCrypt volume has been unmounted and locked

  Scenario: Use Unlock VeraCrypt Volumes to unlock a USB drive that has a hidden VeraCrypt volume
    When I plug a USB drive containing a hidden VeraCrypt volume
    And I cancel the GNOME authentication prompt
    And I unlock and mount this VeraCrypt volume with Unlock VeraCrypt Volumes
    And I open this VeraCrypt volume in GNOME Files
    Then I see the expected contents in this VeraCrypt volume
    When I lock the currently opened VeraCrypt volume
    Then the VeraCrypt volume has been unmounted and locked

  Scenario: Use Unlock VeraCrypt Volumes to unlock a basic VeraCrypt file container with a PIM
    When I plug and mount a USB drive containing a basic VeraCrypt file container with a PIM
    And I unlock and mount this VeraCrypt file container with Unlock VeraCrypt Volumes
    And I open this VeraCrypt volume in GNOME Files
    Then I see the expected contents in this VeraCrypt volume
    When I lock the currently opened VeraCrypt file container
    Then the VeraCrypt file container has been unmounted and locked

  Scenario: Use Unlock VeraCrypt Volumes to unlock a hidden VeraCrypt file container
    When I plug and mount a USB drive containing a hidden VeraCrypt file container
    And I unlock and mount this VeraCrypt file container with Unlock VeraCrypt Volumes
    And I open this VeraCrypt volume in GNOME Files
    Then I see the expected contents in this VeraCrypt volume
    When I lock the currently opened VeraCrypt file container
    Then the VeraCrypt file container has been unmounted and locked

### GNOME Disks

  Scenario: Use GNOME Disks to unlock a USB drive that has a basic VeraCrypt volume with a keyfile
    When I plug a USB drive containing a basic VeraCrypt volume with a keyfile
    And I cancel the GNOME authentication prompt
    And I unlock and mount this VeraCrypt volume with GNOME Disks
    And I open this VeraCrypt volume in GNOME Files
    Then I see the expected contents in this VeraCrypt volume
    When I lock the currently opened VeraCrypt volume
    Then the VeraCrypt volume has been unmounted and locked

  Scenario: Use GNOME Disks to unlock a USB drive that has a hidden VeraCrypt volume
    When I plug a USB drive containing a hidden VeraCrypt volume
    And I cancel the GNOME authentication prompt
    And I unlock and mount this VeraCrypt volume with GNOME Disks
    And I open this VeraCrypt volume in GNOME Files
    Then I see the expected contents in this VeraCrypt volume
    When I lock the currently opened VeraCrypt volume
    Then the VeraCrypt volume has been unmounted and locked

  Scenario: Use GNOME Disks to unlock a basic VeraCrypt file container with a keyfile
    When I plug and mount a USB drive containing a basic VeraCrypt file container with a keyfile
    And I unlock and mount this VeraCrypt file container with GNOME Disks
    And I open this VeraCrypt volume in GNOME Files
    Then I see the expected contents in this VeraCrypt volume
    When I lock the currently opened VeraCrypt file container
    Then the VeraCrypt file container has been unmounted and locked

  Scenario: Use GNOME Disks to unlock a hidden VeraCrypt file container
    When I plug and mount a USB drive containing a hidden VeraCrypt file container
    And I unlock and mount this VeraCrypt file container with GNOME Disks
    And I open this VeraCrypt volume in GNOME Files
    Then I see the expected contents in this VeraCrypt volume
    When I lock the currently opened VeraCrypt file container
    Then the VeraCrypt file container has been unmounted and locked

  Scenario: Use GNOME Disks to unlock a basic VeraCrypt file container with a PIM
    When I plug and mount a USB drive containing a basic VeraCrypt file container with a PIM
    And I unlock and mount this VeraCrypt file container with GNOME Disks
    And I open this VeraCrypt volume in GNOME Files
    Then I see the expected contents in this VeraCrypt volume
    When I lock the currently opened VeraCrypt file container
    Then the VeraCrypt file container has been unmounted and locked
