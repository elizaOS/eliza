require 'rubygems'
require 'time'
require 'rspec'

# Force UTF-8. Ruby will default to the system locale, and if it is
# non-UTF-8, String-methods will fail when operating on non-ASCII
# strings.
Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# Opt-in for deprecation warnings, so we learn early enough about code
# that will break with newer Ruby versions (example: the separation of
# positional and keyword arguments in Ruby 3.0).
Warning[:deprecated] = true if Warning.respond_to?(:[]=)

def fatal_system(...)
  unless system(...)
    raise StandardError, "Command exited with #{$CHILD_STATUS}"
  end
end

def git_exists?
  File.exist? '.git'
end

def create_git
  Dir.mkdir 'config'
  FileUtils.touch('config/base_branch')
  Dir.mkdir('config/APT_overlays.d')
  Dir.mkdir('config/APT_snapshots.d')
  ['debian', 'debian-security', 'torproject'].map do |origin|
    Dir.mkdir("config/APT_snapshots.d/#{origin}")
  end
  Dir.mkdir 'debian'
  File.open('debian/changelog', 'w') do |changelog|
    changelog.write(<<~END_OF_CHANGELOG)
      tails (0) stable; urgency=low

        * First release.

       -- Tails developers <foundations@tails.net>  Mon, 30 Jan 2012 01:00:00 +0000
    END_OF_CHANGELOG
  end

  fatal_system 'git init --quiet'
  fatal_system "git config user.email 'foundations@tails.net'"
  fatal_system "git config user.name 'Tails developers'"
  fatal_system 'git add debian/changelog'
  fatal_system "git commit --quiet debian/changelog -m 'First release'"
  fatal_system 'git branch -M stable'
  fatal_system 'git branch testing stable'
  fatal_system 'git branch devel stable'
  fatal_system 'git branch feature/jessie devel'
end

def current_branch
  cmd = 'git rev-parse --symbolic-full-name --abbrev-ref HEAD'.split
  branch = cmd_helper(cmd).strip
  assert_not_equal('HEAD', branch, "We are in 'detached HEAD' state")
  branch
end

# In order: if git HEAD is tagged, return its name; if a branch is
# checked out, return its name; otherwise we are in 'detached HEAD'
# state, and we return the empty string.
def describe_git_head
  cmd_helper("git describe --tags --exact-match #{current_commit}".split).strip
rescue CommandFailed
  begin
    current_branch
  rescue CommandFailed, Test::Unit::AssertionFailedError
    ''
  end
end

def current_commit
  cmd_helper('git rev-parse HEAD'.split).strip
end

def current_short_commit
  current_commit[0, 7]
end

RSpec::Matchers.define :have_suite do |suite|
  match do |string|
    # e.g.: `deb http://deb.tails.boum.org/ 0.10 main contrib non-free`
    %r{^deb +http://deb\.tails\.boum\.org/ +#{Regexp.escape(suite)} main}
      .match(string)
  end
  failure_message_for_should do |string|
    "expected the sources to include #{suite}\nCurrent sources : #{string}"
  end
  failure_message_for_should_not do |string|
    "expected the sources to exclude #{suite}\nCurrent sources : #{string}"
  end
  description do
    "expected an output with #{suite}"
  end
end

RSpec::Matchers.define :have_tagged_snapshot do |tag|
  match do |string|
    # e.g.: `http://tagged.snapshots.deb.tails.boum.org/0.10`
    base_uri = 'http://tagged.snapshots.deb.tails.boum.org'
    %r{^#{Regexp.escape(base_uri)}/#{Regexp.escape(tag)}/[a-z-]+$}
      .match(string)
  end
  failure_message_for_should do |string|
    "expected the mirror to be #{tag}\nCurrent mirror: #{string}"
  end
  failure_message_for_should_not do |string|
    "expected the mirror not to be #{tag}\nCurrent mirror: #{string}"
  end
  description do
    "expected an output with #{tag}"
  end
end

RSpec::Matchers.define :have_time_based_snapshot do
  match do |string|
    # e.g.: `http://time-based.snapshots.deb.tails.boum.org/debian/2016060602`
    %r{^http://time-based\.snapshots\.deb\.tails\.boum\.org/[^/]+/\d+}
      .match(string)
  end
  failure_message_for_should do |string|
    "expected the mirror to be a time-based snapshot\nCurrent mirror: #{string}"
  end
  failure_message_for_should_not do |string|
    "expected the mirror not to be a time-based snapshot\n" \
    "Current mirror: #{string}"
  end
  description do
    'expected a time-based snapshot'
  end
end
