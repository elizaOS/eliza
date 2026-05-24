CHUTNEY_DATA_DIR = "#{$config['TMPDIR']}/chutney-data".freeze
CHUTNEY_NETWORK_DEFINITION = "#{GIT_DIR}/features/chutney/test-network".freeze

class ChutneyBootstrapFailure < StandardError
end

def chutney_status_log(cmd)
  action = case cmd
           when 'start'
             'starting'
           when 'stop'
             'stopping'
           when 'stop_old'
             'cleaning up old instance'
           when 'kill'
             'killing leftover processes'
           when 'configure'
             'configuring'
           when 'wait_for_bootstrap'
             'waiting for bootstrap (might take a few minutes)'
           when 'done'
             'started!'
           when 'failed'
             'failed to bootstrap despite retrying, aborting run'
           else
             return
           end
  debug_log("Chutney Tor network simulation: #{action} ...")
end

def chutney_disable_info_level_logging
  Dir.glob("#{CHUTNEY_DATA_DIR}/nodes/*/torrc") do |torrc_path|
    File.write(torrc_path, File.read(torrc_path).gsub(/^Log info .*$/, ''))
  end
end

def chutney_cmd(cmd, *args, **opts)
  chutney_script = "#{GIT_DIR}/features/scripts/chutney"
  chutney_status_log(cmd)
  cmd = 'stop' if cmd == 'stop_old'
  cmd_helper([chutney_script, '--data-dir', CHUTNEY_DATA_DIR, cmd, *args], **opts)
end

def chutney_data_dir_cleanup
  if File.directory?(CHUTNEY_DATA_DIR)
    FileUtils.rm_r(CHUTNEY_DATA_DIR)
  end
end

def chutney_processes_match_args
  [
    '--full',
    '--exact',
    "tor -f #{CHUTNEY_DATA_DIR}/nodes.*/.*/torrc (--quiet|--hush)",
  ]
end

def chutney_processes_running?
  cmd_helper(['pgrep', *chutney_processes_match_args])
rescue CommandFailed
  false
else
  true
end

def wait_until_chutney_is_working
  assert_not_nil($chutney_bootstraping)
  chutney_status_log('wait_for_bootstrap')
  $chutney_bootstraping.lock
  raise $chutney_bootstrap_failure unless $chutney_bootstrap_failure.nil?
ensure
  $chutney_bootstraping.unlock
end

def kill_chutney_processes(sigkill: false)
  pkill_args = (sigkill ? ['-KILL'] : []) + chutney_processes_match_args
  begin
    cmd_helper(['pkill', *pkill_args])
  rescue CommandFailed
    # Either nothing matched, which means we're done, or the
    # signalling failed, which means we're not done, so we're treating
    # pkill failure and success the same.
  end

  try_for(30) do
    assert_raise(CommandFailed) do
      cmd_helper(['pgrep', *chutney_processes_match_args])
    end
    true
  end
end

def clean_up_old_chutney_processes
  # After an unclean shutdown of the test suite (e.g. Ctrl+C) the
  # tor processes are left running, listening on the same ports we
  # are about to use. If chutney's data dir also was removed, this
  # will prevent chutney from starting the network unless the tor
  # processes are killed manually.
  if File.directory?(CHUTNEY_DATA_DIR)
    begin
      chutney_cmd('stop_old')
      return unless chutney_processes_running?
    rescue CommandFailed
      # Chutney raised an error while attempting to cleanly kill the
      # old processes, so we fall back to our more abrupt approach.
    end
  end
  chutney_status_log('kill')
  begin
    kill_chutney_processes
  rescue StandardError
    kill_chutney_processes(sigkill: true)
  end
end

def initialize_chutney
  # Ensure that a fresh chutney instance is running, and that it will
  # be cleaned upon exit. We only do it once, though, since the same
  # setup can be used throughout the same test suite run.
  return if $chutney_initialized

  recovering_chutney = KEEP_CHUTNEY && File.directory?(CHUTNEY_DATA_DIR)
  clean_up_old_chutney_processes
  if recovering_chutney
    # We sometimes look for strings in the Chutney nodes' logs so we
    # clear them so previous runs do not affect the current one.
    Dir.glob("#{$config['TMPDIR']}/chutney-data/nodes/*/notice.log") do |log|
      FileUtils.rm_f(log)
    end
  else
    chutney_data_dir_cleanup
    chutney_cmd(
      'init',
      '--net-from-script-path', CHUTNEY_NETWORK_DEFINITION,
      '--listen-address', $vmnet.bridge_ip_address.to_s
    )
    chutney_cmd('configure')
    chutney_disable_info_level_logging
  end
  begin
    chutney_cmd('start')
  rescue CommandFailed => e
    raise e unless recovering_chutney

    raise e, %{#{e.message}

Note: You are running with --keep-snapshots or --keep-chutney, but Chutney
failed to start with its current data directory. To recover you likely
want to delete Chutney's data directory and all test suite snapshots:

    sudo rm -r #{CHUTNEY_DATA_DIR}

    for snapshot in $(virsh snapshot-list --name TailsToaster); do
      virsh snapshot-delete TailsToaster --snapshotname "${snapshot}"
    done

}
  end

  at_exit do
    chutney_cmd('stop')
    chutney_data_dir_cleanup unless KEEP_CHUTNEY
  end

  Thread.new do
    ensure_chutney_bootstraps
  rescue StandardError => e
    chutney_status_log('failed')
    $chutney_bootstrap_failure = e
  end

  $chutney_initialized = true
end

# rubocop:disable Metrics/AbcSize
def ensure_chutney_bootstraps
  return unless $chutney_bootstraping.nil?

  $chutney_bootstraping = Mutex.new
  $chutney_bootstraping.lock

  restart_chutney = proc do
    debug_log('Chutney failed to bootstrap, retrying...')
    chutney_cmd('stop')
    chutney_cmd('start')
  end

  begin
    retry_action(2, recovery_proc: restart_chutney) do
      # Documentation: submodules/chutney/README, "Waiting for the network" section
      chutney_cmd('wait_for_bootstrap', output_in_exception: false)
    end
  rescue MaxRetriesFailure => e
    # The output from this command is massive, so let's just keep the
    # last status report from the failed command's output.
    message = "#{e.cause.message}\n#{e.cause.command_output[/^Bootstrap failed:.*/m]}"
    raise ChutneyBootstrapFailure, message
  end

  # We have to sanity check that all nodes are running because
  # `chutney start` will return success even if some nodes fail.
  status = chutney_cmd('status')
  match = Regexp.new('^(\d+)/(\d+) nodes are running$').match(status)
  assert_not_nil(match, "Chutney's status did not contain the expected " \
                        'string listing the number of running nodes')
  running, total = match[1, 2].map(&:to_i)
  assert_equal(
    total, running, "Chutney is only running #{running}/#{total} nodes"
  )

  # After bootstrapping it still takes time for bridges (especially
  # those with pluggable transports) to become usable.
  try_for(120) do
    Dir.glob("#{$config['TMPDIR']}/chutney-data/nodes/*") do |node_path|
      torrc_path = "#{node_path}/torrc"
      next unless File.directory?(node_path) && File.exist?(torrc_path)

      torrc = File.read(torrc_path)
      next unless torrc[/BridgeRelay 1/]

      log = File.read("#{node_path}/notice.log")
      unless log[/Self-testing indicates your ORPort .* is reachable from the outside/]
        raise 'Chutney bridge: ORPort not reachable yet'
      end

      if torrc[/^ServerTransportListenAddr/] && !log['Registered server transport']
        raise 'Chutney bridge: server transport not registered yet'
      end
    end
    true
  end

  chutney_status_log('done')
  $chutney_working = true
ensure
  $chutney_bootstraping.unlock
end
# rubocop:enable Metrics/AbcSize

def configure_simulated_Tor_network # rubocop:disable Naming/MethodName
  # At the moment this function essentially assumes that we boot with 'the
  # network is unplugged', run this function, and then 'the network is
  # plugged'. I believe we can make this pretty transparent without
  # the need of a dedicated step by using tags (e.g. @fake_tor or
  # whatever -- possibly we want the opposite, @real_tor,
  # instead).
  #
  # There are two time points where we for a scenario must ensure that
  # the client configuration below is enabled if and only if the
  # scenario is tagged, and that is:
  #
  # 1. During a proper boot, as soon as the remote shell is up in the
  #    'the computer boots Tails' step.
  #
  # 2. When restoring a snapshot, in restore_background().
  #
  # If we do this, it doesn't even matter if a snapshot is made of an
  # untagged scenario (without the conf), and we later restore it with
  # a tagged scenario.
  #
  # Note: We probably have to clear the /var/lib/tor data dir when we
  # switch mode. Possibly there are other such problems that make this
  # abstraction impractical and it's better that we avoid it an go
  # with the more explicit, step-based approach.

  initialize_chutney
  # Most of these lines are taken from chutney's client template.
  client_torrc_lines = [
    'TestingTorNetwork 1',
    'AssumeReachable 1',
    'PathsNeededToBuildCircuits 0.67',
    'TestingDirAuthVoteExit *',
    'TestingDirAuthVoteGuard *',
    'TestingDirAuthVoteHSDir *',
    'TestingMinExitFlagThreshold 0',
    'V3AuthNIntervalsValid 2',
    # Enabling TestingTorNetwork disables ClientRejectInternalAddresses
    # so the Tor client will happily try LAN connections. Coupled with
    # that TestingTorNetwork is enabled on all exits, and their
    # ExitPolicyRejectPrivate is disabled, we will allow exiting to
    # LAN hosts. We have at least one test that tries to make sure
    # that is *not* possible (Scenario: The Tor Browser cannot access
    # the LAN) so we cannot allow it. We'll have to rethink all this
    # if we ever want to run all services locally as well (#9520).
    'ClientRejectInternalAddresses 1',
  ]
  # We run one client in chutney so we easily can grep the generated
  # DirAuthority lines and use them.
  client_torrcs = Dir.glob(
    "#{$config['TMPDIR']}/chutney-data/nodes/*client/torrc"
  )
  dir_auth_lines = File.open(client_torrcs.first) do |f|
    f.grep(/^(Alternate)?(Dir|Bridge)Authority\s/)
  end
  client_torrc_lines.concat(dir_auth_lines)
  $vm.file_append('/etc/tor/torrc', client_torrc_lines)

  $vm.execute_successfully('systemctl restart tor@default.service')
end

# This is for things that must be run after Chutney's network is
# bootstrapped and everything is ready for clients.
def finalize_simulated_Tor_network_configuration # rubocop:disable Naming/MethodName
  # Since we use a simulated Tor network (via Chutney) we have to
  # switch to its default bridges.
  default_bridges_path = '/usr/share/tails/tca/default_bridges.txt'
  bridges = chutney_bridges('obfs4', chutney_tag: 'defbr')
  $vm.file_overwrite(
    default_bridges_path,
    bridges.map { |l| l[:line] }
  )
end
