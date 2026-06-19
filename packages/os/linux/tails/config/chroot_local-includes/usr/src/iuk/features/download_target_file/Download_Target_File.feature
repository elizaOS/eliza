Feature: download and verify a target file
  As a Tails developer
  I work on the Tails upgrade system
  I want to make sure the IUK downloader and verifier works properly

  Background:
    Given a usable temporary directory
    And a random port
    And another random port

  Scenario: Not enough free space in /tmp
    When I download "<file>" (of expected size 1234567890123) from "/", and check its hash is "dummy_hash"
    Then it should fail
    And I should be told "requires .+ of free space in /tmp/[^,]+, but only .+ is available"
    And I should not see the downloaded file in the temporary directory
    Examples:
      | file           | content |
      | whatever1.file | abc     |

  Scenario: Successful download and verification of a target file
    Given an HTTP server that serves "<file>" in "<webdir>" with content "<content>" and hash "<sha256>"
    When I download "<file>" (of expected size <size>) from "<webdir>", and check its hash is "<sha256>"
    Then it should succeed
    And I should see the downloaded file in the temporary directory
    And the SHA-256 of the downloaded file should be "<sha256>"
    And the downloaded file should be world-readable
    Examples:
      | file           | webdir   | content | size | sha256                                                           |
      | whatever1.file | /        | abc     |    3 | ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad |
      | whatever2.file | /sub/dir | 123     |    3 | a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3 |

  @retry
  Scenario: Successfully resuming an interrupted download, from the same mirror
    Given an HTTP server that supports Range requests and serves "<file>" in "<webdir>" with content "<content>" and hash "<sha256>"
    When I download "<file>" (of expected size <size>) from "<webdir>", failing 1 time, and check its hash is "<sha256>"
    Then it should succeed
    And I should be told "Sending HTTP request: attempt no. 1"
    And I should be told "Resuming download after 1 bytes"
    And I should be told "Sending HTTP request: attempt no. 2"
    And I should not be told "Falling back to DNS mirror pool"
    And I should see the downloaded file in the temporary directory
    And the SHA-256 of the downloaded file should be "<sha256>"
    And the downloaded file should be world-readable
    Examples:
      | file           | webdir   | content | size | sha256                                                           |
      | whatever1.file | /        | abc     |    3 | ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad |
      | whatever2.file | /sub/dir | 123     |    3 | a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3 |

  Scenario: Successful download and verification with redirect to another hostname over HTTPS
    Given an HTTP server that redirects to 127.0.0.2 over HTTPS
    And an HTTPS server on 127.0.0.2 that serves "<file>" in "<webdir>" with content "<content>" and hash "<sha256>"
    When I download "<file>" (of expected size <size>) from "<webdir>", and check its hash is "<sha256>"
    Then it should succeed
    And I should see the downloaded file in the temporary directory
    And the SHA-256 of the downloaded file should be "<sha256>"
    Examples:
      | file           | webdir   | content | size | sha256 |
      | whatever1.file | /        |     abc |   3  | ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  |
      | whatever2.file | /sub/dir |     123 |   3  | a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3  |

  Scenario: Failed download of a target file from a non-existing server
    When I download "<file>" (of expected size 42) from "/", and check its hash is "dummy_hash"
    Then it should fail
    And I should be told "Could not download '[^']*<file>'"
    And I should not see the downloaded file in the temporary directory
    Examples:
      | file           | content |
      | whatever1.file | abc     |

  Scenario: Failed download of a non-existing target file
    Given an HTTP server that does not serve "<file>" in "<webdir>"
    When I download "<file>" (of expected size 42) from "<webdir>", and check its hash is "dummy_hash"
    Then it should fail
    And I should be told "Could not download '[^']*<file>'"
    And I should not see the downloaded file in the temporary directory
    Examples:
      | file           | webdir   |
      | whatever1.file | /        |
      | whatever2.file | /sub/dir |

  Scenario: Failed verification of a target file with wrong hash
    Given an HTTP server that serves "<file>" in "<webdir>" with content "<content>" and hash "<good-sha256>"
    When I download "<file>" (of expected size <size>) from "<webdir>", and check its hash is "<bad-sha256>"
    Then it should fail
    And I should be told "The file '[^']*<file>' was downloaded but its hash is not correct"
    And I should not see the downloaded file in the temporary directory
    Examples:
      | file           | webdir   | content | size | good-sha256                                                       | bad-sha256         |
      | whatever1.file | /        | abc     |    3 | ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  | I'd rather not to  |
      | whatever2.file | /sub/dir | 12345   |    5 | 5994471abb01112afcc18159f6cc74b4f511b99806da59b3caf5a9c173cacfc5  | I'd rather not to  |

  Scenario: Failed download of a target file that is bigger than expected
    Given an HTTP server that serves "<file>" in "<webdir>" with size "<size>" and hash "<sha256>"
    When I download "<file>" (of expected size <expected_size>) from "<webdir>", and check its hash is "<sha256>"
    Then it should fail
    And I should be told "Could not download .*[(]Client-Aborted[)]: max_size"
    Examples:
      | file           | webdir   |    size | expected_size | sha256                                                           |
      | whatever1.file | /        | 1234567 |             1 | ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad |
      | whatever2.file | /sub/dir |    2048 |             2 | a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3 |

  Scenario: Failed download of a target file that is smaller than expected
    Given an HTTP server that serves "<file>" in "<webdir>" with size "<size>" and hash "<sha256>"
    When I download "<file>" (of expected size <expected_size>) from "<webdir>", and check its hash is "<sha256>"
    Then it should fail
    And I should be told "The file '[^']*<file>' was downloaded but its size .* should be .*"
    And I should not see the downloaded file in the temporary directory
    Examples:
      | file           | webdir   | size | expected_size | sha256                                                           |
      | whatever1.file | /        |    3 |            42 | ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad |
      | whatever2.file | /sub/dir |   41 |            42 | a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3 |
