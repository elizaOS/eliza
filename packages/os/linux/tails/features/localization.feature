@product
Feature: Localization
  As a Tails user
  I want Tails to be localized in my native language
  And various Tails features should still work

  Scenario Outline: Do not localize the XDG User Dirs to be able to use those dirs in Tor Browser (#19255)
    Given I have started Tails from DVD without network and stopped at Tails Greeter's login screen
    And I log in to a new session in German (de)
    Then the live user's <dir> directory exists
    And there is a GNOME bookmark for the <dir> directory
    Examples:
      | dir |
      | Documents |
      | Downloads |
      | Music |
      | Pictures |
      | Videos |

  @doc @slow @not_release_blocker
  Scenario Outline: Tails is localized for every tier-1 language
    Given I have started Tails from DVD without network and stopped at Tails Greeter's login screen
    When I log in to a new session in <language> (<lang_code>)
    Then the keyboard layout is set to "<layout>"
    And tpsd is localized to the selected locale
    When the network is plugged
    And Tor is ready
    Then I successfully start the Unsafe Browser
    And I kill the Unsafe Browser
    When I enable the screen keyboard
    Then the screen keyboard works in Tor Browser
    And DuckDuckGo is the default search engine
    And I kill the Tor Browser
    And the screen keyboard works in Thunderbird
    And the layout of the screen keyboard is set to "<osk_layout>"

    # This list has to be kept in sync' with our list of tier-1 languages:
    #   https://tails.net/contribute/how/translate/#tier-1-languages

    # Known issues, that this step effectively verifies are still present:
    #  - Not all localized layouts exist in the GNOME screen keyboard: #8444
    Examples:
      | language   | layout | osk_layout | lang_code |
      | Arabic     | eg     | us         | ar    |
      | Chinese    | cn     | us         | zh_CN |
      | English    | us     | us         | en    |
      | French     | fr     | fr         | fr    |
      | German     | de     | de         | de    |
      | Hindi      | in     | us         | hi    |
      | Indonesian | id     | us         | id    |
      | Italian    | it     | us         | it    |
      | Persian    | ir     | ir         | fa    |
      | Portuguese | pt     | us         | pt    |
      | Russian    | ru     | ru         | ru    |
      | Spanish    | es     | us         | es    |
      | Turkish    | tr     | us         | tr    |

  Scenario: Tails doesn't store localization preferences in cleartext unless it's asked to
    Given I have started Tails without network from a USB drive without a persistent partition and stopped at Tails Greeter's login screen
    When I set the language to Italian (it)
    Then the language and keyboard have not been saved in cleartext storage
    When I shutdown Tails and wait for the computer to power off
    And I start Tails from USB drive "__internal" with network unplugged
    Then the Welcome Screen's language is set to English

  Scenario: Tails stores localization preferences when it's asked to
    Given I have started Tails without network from a USB drive without a persistent partition and stopped at Tails Greeter's login screen
    When I set the language to Italian (it)
    And I save the language and keyboard options in cleartext storage
    Then the "it" language and keyboard have been saved in cleartext storage
    When I set the language to French (fr)
    Then the "fr" language and keyboard have been saved in cleartext storage
    And I shutdown Tails and wait for the computer to power off
    And I start Tails from USB drive "__internal" with network unplugged
    Then the "fr" language and keyboard have been saved in cleartext storage
    And the Welcome Screen's language is set to French
    When I log in to a new session
    Then the language is set to French

  Scenario: Cleartext localization preferences have priority over Persistent Storage
    Given I have started Tails without network from a USB drive without a persistent partition and logged in
    # The first boot simulates a legacy Tails, where locale is only saved in Persistent Storage
    Then Tails is running from USB drive "__internal"
    And I create a persistent partition
    And I manually store legacy localization settings in Persistent Storage
    When I shutdown Tails and wait for the computer to power off
    # The second boot verifies that the legacy setting still works
    And I start Tails from USB drive "__internal" with network unplugged
    Then the Welcome Screen's language is set to English
    And the Welcome Screen's formats is set to United States
    When I enable persistence
    Then the Welcome Screen's language is set to German
    And the Welcome Screen's formats is set to France
    When I set the language to Italian (it)
    Then the language and keyboard have not been saved in cleartext storage
    When I save the language and keyboard options in cleartext storage
    Then the "it" language and keyboard have been saved in cleartext storage
    And I shutdown Tails and wait for the computer to power off
    # The third boot verifies that cleartext has priority
    And I start Tails from USB drive "__internal" with network unplugged
    Then the Welcome Screen's language is set to Italian
    And the Welcome Screen's formats is set to Italy
    When I enable persistence
    # Only formats are loaded from persistence
    Then the Welcome Screen's formats is set to France
    And the Welcome Screen's language is set to Italian
