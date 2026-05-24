# -*- mode: ruby -*-
# vi: set ft=ruby :
#
# Tails: https://tails.net/
# Copyright © 2012 Tails developers <foundations@tails.net>
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

require 'date'
require 'English'
require 'libvirt'
require 'open3'
require 'rbconfig'
require 'uri'

require_relative 'vagrant/lib/tails_build_settings'

# Path to the directory which holds our Vagrantfile
VAGRANT_PATH = File.expand_path('vagrant', __dir__)

# Branches that are considered 'stable' (used to select SquashFS compression)
STABLE_BRANCH_NAMES = ['stable', 'testing'].freeze

EXPORTED_VARIABLES = [
  'JENKINS_URL',
  'MKSQUASHFS_OPTIONS',
  'APT_SNAPSHOTS_SERIALS',
  'TAILS_ACNG_PROXY',
  'TAILS_BUILD_FAILURE_RESCUE',
  'TAILS_DATE_OFFSET',
  'TAILS_OFFLINE_MODE',
  'TAILS_PROXY',
  'TAILS_PROXY_TYPE',
  'TAILS_RAM_BUILD',
  'TAILS_WEBSITE_CACHE',
  'GIT_COMMIT',
  'GIT_REF',
  'BASE_BRANCH_GIT_COMMIT',
  'FEATURE_BRANCH_GIT_COMMIT',
].freeze
ENV['EXPORTED_VARIABLES'] = EXPORTED_VARIABLES.join(' ')

EXTERNAL_HTTP_PROXY = ENV['http_proxy']

# In-VM proxy URL
INTERNAL_HTTP_PROXY = 'http://127.0.0.1:3142'.freeze

ENV['ARTIFACTS'] ||= '.'

ENV['APT_SNAPSHOTS_SERIALS'] ||= ''

ENV['TAILS_BUILD_FAILURE_RESCUE'] ||= ''
ENV['TAILS_DATE_OFFSET'] ||= ''
ENV['TAILS_OFFLINE_MODE'] ||= ''
ENV['TAILS_PROXY_TYPE'] ||= 'vmproxy'
ENV['TAILS_RAM_BUILD'] ||= 'no'

class CommandError < StandardError
  attr_reader :status, :stderr

  def initialize(message, **opts)
    opts[:status] ||= nil
    opts[:stderr] ||= nil
    @status = opts[:status]
    @stderr = opts[:stderr]
    super(format(message, status: @status, stderr: @stderr))
  end
end

def run_command(*args, **kwargs)
  Process.wait Kernel.spawn(*args, **kwargs)
  return if $CHILD_STATUS.exitstatus.zero?

  raise CommandError.new("command #{args}, #{kwargs} failed " \
                         'with exit status %<status>s',
                         status: $CHILD_STATUS.exitstatus)
end

def capture_command(*args, **kwargs)
  stdout, stderr, proc_status = Open3.capture3(*args, **kwargs)
  if proc_status.exitstatus != 0
    raise CommandError.new("command #{args}, #{kwargs} failed with exit status " \
                           '%<status>s: %<stderr>s',
                           stderr:, status: proc_status.exitstatus)
  end
  [stdout, stderr]
end

def git_helper(*args, **kwargs)
  question = args.first.end_with?('?')
  args.first.sub!(/\?$/, '')
  status = 0
  stdout = ''
  begin
    stdout, = capture_command('auto/scripts/utils.sh', *args, **kwargs)
  rescue CommandError => e
    status = e.status
  end
  question ? status.zero? : stdout.chomp
end

class VagrantCommandError < CommandError
end

# Runs the vagrant command, letting stdout/stderr through. Throws an
# exception unless the vagrant command succeeds.
def run_vagrant(*args, **kwargs)
  run_command('vagrant', *args, chdir: './vagrant', **kwargs)
rescue CommandError => e
  raise(VagrantCommandError, "'vagrant #{args}' command failed with exit " \
                             "status #{e.status}")
end

# Runs the vagrant command, not letting stdout/stderr through, and
# returns [stdout, stderr, Process::Status].
def capture_vagrant(*args, **kwargs)
  capture_command('vagrant', *args, chdir: './vagrant', **kwargs)
rescue CommandError => e
  raise(VagrantCommandError, "'vagrant #{args}' command failed with exit " \
                             "status #{e.status}: #{e.stderr}")
end

[:run_vagrant, :capture_vagrant].each do |m|
  define_method "#{m}_ssh" do |*args|
    method(m).call('ssh', '-c', *args, '--', '-q')
  end
end

def vagrant_ssh_config(key)
  # Cache results
  if $vagrant_ssh_config.nil?
    $vagrant_ssh_config = capture_vagrant('ssh-config')
                          .first.split("\n") \
                          .map { |line| line.strip.split(/\s+/, 2) }.to_h
    # The path in the ssh-config output is quoted, which is not what
    # is expected outside of a shell, so let's get rid of the quotes.
    $vagrant_ssh_config['IdentityFile'].gsub!(/^"|"$/, '')
  end
  $vagrant_ssh_config[key]
end

def current_vm_cpus
  capture_vagrant_ssh('grep -c "^processor\s*:" /proc/cpuinfo').first.chomp.to_i
end

def vm_state
  out, = capture_vagrant('status')
  status_line = out.split("\n")[2]
  if    status_line['not created']
    :not_created
  elsif status_line['shutoff']
    :poweroff
  elsif status_line['running']
    :running
  else
    raise 'could not determine VM state'
  end
end

def releasing?
  git_helper('git_on_a_tag?')
end

def system_cpus
  File.read('/proc/cpuinfo').scan(/^processor\s+:/).count
end

ENV['TAILS_WEBSITE_CACHE'] = releasing? ? 'no' : 'yes'

task :check_ci_configuration do
  if on_jenkins?
    begin
      run_command('./bin/ci-configuration', 'should-build')
    rescue CommandError
      abort 'This branch is configured to skip build on Jenkins'
    end
  end
end

task :parse_build_options do
  options = []

  # Default to build using the in-VM proxy
  options << 'vmproxy'
  # Default to fast compression on development branches
  options << 'fastcomp' unless releasing?
  # Default to use all host CPUs
  options << "cpus=#{system_cpus}"

  options += ENV['TAILS_BUILD_OPTIONS'].split if ENV['TAILS_BUILD_OPTIONS']

  options.uniq.each do |opt| # rubocop:disable Metrics/BlockLength
    case opt
    # Memory build settings
    when 'ram'
      ENV['TAILS_RAM_BUILD'] = 'yes'
    when 'noram'
      ENV['TAILS_RAM_BUILD'] = 'no'
    # Bootstrap cache settings
    # HTTP proxy settings
    when 'extproxy'
      unless EXTERNAL_HTTP_PROXY
        abort 'No HTTP proxy set, but one is required by ' \
              'TAILS_BUILD_OPTIONS. Aborting.'
      end
      ENV['TAILS_PROXY'] = EXTERNAL_HTTP_PROXY
      ENV['TAILS_PROXY_TYPE'] = 'extproxy'
    when 'vmproxy', 'vmproxy+extproxy'
      ENV['TAILS_PROXY'] = INTERNAL_HTTP_PROXY
      ENV['TAILS_PROXY_TYPE'] = 'vmproxy'
      if opt == 'vmproxy+extproxy'
        unless EXTERNAL_HTTP_PROXY
          abort 'No HTTP proxy set, but one is required by ' \
                'TAILS_BUILD_OPTIONS. Aborting.'
        end
        ENV['TAILS_ACNG_PROXY'] = EXTERNAL_HTTP_PROXY
      end
    when 'offline'
      ENV['TAILS_OFFLINE_MODE'] = '1'
    when /cachewebsite(?:=([a-z]+))?/
      value = Regexp.last_match(1)
      if releasing?
        warn "Building a release ⇒ ignoring #{opt} build option"
        ENV['TAILS_WEBSITE_CACHE'] = 'no'
      else
        value = 'yes' if value.nil?
        case value
        when 'yes'
          ENV['TAILS_WEBSITE_CACHE'] = 'yes'
        when 'no'
          ENV['TAILS_WEBSITE_CACHE'] = 'no'
        else
          raise "Unsupported value for cachewebsite option: #{value}"
        end
      end
    # SquashFS compression settings
    when 'fastcomp', 'gzipcomp'
      if releasing?
        warn "Building a release ⇒ ignoring #{opt} build option"
        ENV['MKSQUASHFS_OPTIONS'] = nil
      else
        ENV['MKSQUASHFS_OPTIONS'] = '-comp zstd -no-exports'
      end
    when 'defaultcomp'
      ENV['MKSQUASHFS_OPTIONS'] = nil
    # Virtual hardware settings
    when /machinetype=([a-zA-Z0-9_.-]+)/
      ENV['TAILS_BUILD_MACHINE_TYPE'] = Regexp.last_match(1)
    when /cpus=(\d+)/
      ENV['TAILS_BUILD_CPUS'] = Regexp.last_match(1)
    when /memory=(\d+)/
      ENV['TAILS_BUILD_MEMORY'] = Regexp.last_match(1)
    when /cpumodel=([a-zA-Z0-9_-]+)/
      ENV['TAILS_BUILD_CPU_MODEL'] = Regexp.last_match(1)
    # Git settings
    when 'ignorechanges'
      ENV['TAILS_BUILD_IGNORE_CHANGES'] = '1'
    when /dateoffset=([-+]\d+)/
      ENV['TAILS_DATE_OFFSET'] = Regexp.last_match(1)
    # Developer convenience features
    when 'keeprunning'
      $keep_running = true
      $force_cleanup = false
    when 'forcecleanup'
      $force_cleanup = true
      $keep_running = false
    when 'rescue'
      $keep_running = true
      ENV['TAILS_BUILD_FAILURE_RESCUE'] = '1'
    # Jenkins
    when 'nomergebasebranch'
      $skip_mergebasebranch = true
    else
      raise "Unknown Tails build option '#{opt}'"
    end
  end

  if ENV['TAILS_OFFLINE_MODE'] == '1' && ENV['TAILS_PROXY'].nil?
    abort 'You must use a caching proxy when building offline'
  end
end

task :ensure_enough_free_memory do
  next unless vm_state == :not_created

  cpus = ENV['TAILS_BUILD_CPUS'].to_i
  free_memory = capture_command('free', '--mebi').first.split[12].to_i
  required_memory = if ENV['TAILS_RAM_BUILD'] == 'yes'
                      vm_memory_for_ram_builds
                    else
                      vm_memory_for_disk_builds(cpus)
                    end

  if free_memory < required_memory
    message = <<-END_OF_MESSAGE.gsub(/^ */, '')

      There is not enough free memory to start the virtual machine: only
      #{free_memory} MB is free but #{required_memory} MB is required.

    END_OF_MESSAGE
    message += if ENV['TAILS_RAM_BUILD'] == 'yes'
                 <<-END_OF_MESSAGE.gsub(/^ */, '')
      Try again with the `noram` option added to the TAILS_BUILD_OPTIONS
      environment variable to force a slower on-disk build.

                 END_OF_MESSAGE
               else
                 <<-END_OF_MESSAGE.gsub(/^ */, '')
      Try freeing up some system memory before attempting to build again.

                 END_OF_MESSAGE
               end
    abort message
  end
end

task :ensure_clean_repository do
  git_status = `git status --porcelain`
  unless git_status.empty?
    if ENV['TAILS_BUILD_IGNORE_CHANGES']
      warn <<-END_OF_MESSAGE.gsub(/^        /, '')

        You have uncommitted changes in the Git repository. They will
        be ignored for the upcoming build:
        #{git_status}

      END_OF_MESSAGE
    else
      warn <<-END_OF_MESSAGE.gsub(/^        /, '')

        You have uncommitted changes in the Git repository. Due to limitations
        of the build system, you need to commit them before building Tails:
        #{git_status}

        If you don't care about those changes and want to build Tails nonetheless,
        please add `ignorechanges` to the TAILS_BUILD_OPTIONS environment
        variable.

      END_OF_MESSAGE
      abort 'Uncommitted changes. Aborting.'
    end
  end
end

def list_artifacts
  user = vagrant_ssh_config('User')
  stdout = capture_vagrant_ssh("find '/home/#{user}/amnesia/' -maxdepth 1 " \
                                        "-name 'tails-amd64-*' " \
                                        '-o -name tails-build-env.list').first
  stdout.split("\n")
rescue VagrantCommandError
  []
end

def remove_artifacts
  list_artifacts.each do |artifact|
    run_vagrant_ssh("sudo rm -f '#{artifact}'")
  end
end

task ensure_clean_home_directory: ['vm:up'] do
  remove_artifacts
end

task :validate_http_proxy do
  if ENV['TAILS_PROXY']
    proxy_host = URI.parse(ENV['TAILS_PROXY']).host

    if proxy_host.nil?
      ENV['TAILS_PROXY'] = nil
      abort "Invalid HTTP proxy: #{ENV['TAILS_PROXY']}"
    end

    if ENV['TAILS_PROXY_TYPE'] == 'vmproxy'
      warn 'Using the internal VM proxy'
    else
      if ['localhost', '[::1]'].include?(proxy_host) \
         || proxy_host.start_with?('127.0.0.')
        abort 'Using an HTTP proxy listening on the host\'s loopback ' \
              'is doomed to fail. Aborting.'
      end
      warn "Using HTTP proxy: #{ENV['TAILS_PROXY']}"
    end
  else
    warn 'No HTTP proxy set.'
  end
end

task :validate_git_state do
  if git_helper('git_in_detached_head?') && !git_helper('git_on_a_tag?')
    raise 'We are in detached head but the current commit is not tagged'
  end
end

task setup_environment: ['validate_git_state'] do
  ENV['GIT_COMMIT'] ||= git_helper('git_current_commit')
  ENV['GIT_REF'] ||= git_helper('git_current_head_name')
  if on_jenkins?
    jenkins_branch = (ENV['GIT_BRANCH'] || '').sub(%r{^origin/}, '')
    if !releasing? && jenkins_branch != ENV['GIT_REF']
      raise "We expected to build the Git ref '#{ENV['GIT_REF']}', " \
            "but GIT_REF in the environment says '#{jenkins_branch}'. Aborting!"
    end
  end

  ENV['BASE_BRANCH_GIT_COMMIT'] ||= git_helper('git_base_branch_head')
  ['GIT_COMMIT', 'GIT_REF', 'BASE_BRANCH_GIT_COMMIT'].each do |var|
    next unless ENV[var].empty?

    raise "Variable '#{var}' is empty, which should not be possible: " \
          "either validate_git_state is buggy or the 'origin' remote " \
          'does not point to the official Tails Git repository.'
  end
end

task merge_base_branch: ['parse_build_options', 'setup_environment'] do
  next if $skip_mergebasebranch

  branch = git_helper('git_current_branch')
  base_branch = git_helper('base_branch')
  source_date_faketime = `date --utc --date="$(dpkg-parsechangelog --show-field=Date)" \
                               '+%Y-%m-%d %H:%M:%S'`.chomp
  next if releasing? || branch == base_branch

  commit_before_merge = git_helper('git_current_commit')
  warn "Merging base branch '#{base_branch}' (at commit " \
       "#{ENV['BASE_BRANCH_GIT_COMMIT']}) ..."
  begin
    run_command('faketime', '-f', source_date_faketime, \
                'git', 'merge', '--no-edit', ENV['BASE_BRANCH_GIT_COMMIT'])
  rescue CommandError
    run_command('git', 'merge', '--abort')
    raise <<-END_OF_MESSAGE.gsub(/^        /, '')

          There were conflicts when merging the base branch; either
          merge it yourself and resolve conflicts, or skip this merge
          by rebuilding with the 'nomergebasebranch' option.

    END_OF_MESSAGE
  end
  run_command('git', 'submodule', 'update', '--init')

  # If we actually merged anything we'll re-run rake in the new Git
  # state in order to avoid subtle build errors due to mixed state.
  next if commit_before_merge == git_helper('git_current_commit')

  ENV['GIT_COMMIT'] = git_helper('git_current_commit')
  ENV['FEATURE_BRANCH_GIT_COMMIT'] = commit_before_merge
  ENV['TAILS_BUILD_OPTIONS'] = "#{ENV['TAILS_BUILD_OPTIONS'] || ''} nomergebasebranch"
  Kernel.exec('rake', *ARGV)
end

task :maybe_clean_up_builder_vms do
  clean_up_builder_vms if $force_cleanup
end

task :ensure_correct_permissions do
  FileUtils.chmod('go+x', '.')
  FileUtils.chmod_R('go+rX', ['.git', 'submodules', 'vagrant'])

  # Changing permissions outside of the working copy, in particular on
  # parent directories such as $HOME, feels too blunt and can have
  # problematic security consequences, so we don't forcibly do that.
  # Instead, when the permissions are not OK, display a nicer error
  # message than "Virtio-9p Failed to initialize fs-driver […]"
  begin
    capture_command('sudo', '-u', 'libvirt-qemu', 'stat', '.git')
  rescue CommandError
    abort <<-END_OF_MESSAGE.gsub(/^      /, '')

      Incorrect permissions: the libvirt-qemu user needs to be allowed
      to traverse the filesystem up to #{ENV['PWD']}.

      To fix this, you can for example run the following command
      on every parent directory of #{ENV['PWD']} up to #{ENV['HOME']}
      (inclusive):

        chmod g+rx DIR && setfacl -m user:libvirt-qemu:rx DIR

    END_OF_MESSAGE
  end
end

desc 'Build Tails'
task build: [
  'check_ci_configuration',
  'parse_build_options',
  'ensure_clean_repository',
  'maybe_clean_up_builder_vms',
  'validate_git_state',
  'setup_environment',
  'merge_base_branch',
  'validate_http_proxy',
  'ensure_correct_permissions',
  'vm:up',
  'ensure_clean_home_directory',
] do
  if ENV['TAILS_BUILD_CPUS'] \
     && current_vm_cpus != ENV['TAILS_BUILD_CPUS'].to_i
    warn <<-END_OF_MESSAGE.gsub(/^        /, '')

        The virtual machine is currently running with #{current_vm_cpus}
        virtual CPU(s). In order to change that number, you need to
        stop the VM first, using `rake vm:halt`. Otherwise, please
        adjust the `cpus` options accordingly.

    END_OF_MESSAGE
    abort 'The virtual machine needs to be reloaded to change the number ' \
          'of CPUs. Aborting.'
  end

  exported_env = EXPORTED_VARIABLES
                 .select { |k| ENV[k] }
                 .map    { |k| "#{k}='#{ENV[k]}'" }.join(' ')

  begin
    retrieved_artifacts = false
    run_vagrant_ssh("#{exported_env} build-tails")
  rescue VagrantCommandError
    retrieve_artifacts(missing_ok: true)
    retrieved_artifacts = true
  ensure
    retrieve_artifacts(missing_ok: false) unless retrieved_artifacts
    clean_up_builder_vms unless $keep_running
  end
ensure
  clean_up_builder_vms if $force_cleanup
end

desc 'Retrieve build artifacts from the Vagrant box'
task :retrieve_artifacts do
  retrieve_artifacts
end

def retrieve_artifacts(missing_ok: false)
  artifacts = list_artifacts
  if artifacts.empty?
    msg = 'No build artifacts were found!'
    raise msg unless missing_ok

    warn msg
    return
  end
  user = vagrant_ssh_config('User')
  hostname = vagrant_ssh_config('HostName')
  key_file = vagrant_ssh_config('IdentityFile')
  warn 'Retrieving artifacts from Vagrant build box.'
  run_vagrant_ssh(
    "sudo chown #{user} " + artifacts.map { |a| "'#{a}'" }.join(' ')
  )
  fetch_command = [
    'scp',
    '-i', key_file,
    # We don't want to use any identity saved in ssh agent'
    '-o', 'IdentityAgent=none',
    # We need this since the user will not necessarily have a
    # known_hosts entry. It is safe since an attacker must
    # compromise libvirt's network config or the user running the
    # command to modify the #{hostname} below.
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    # Speed up the copy
    '-o', 'Compression=no',
  ]
  fetch_command += artifacts.map { |a| "#{user}@#{hostname}:#{a}" }
  fetch_command << ENV['ARTIFACTS']
  run_command(*fetch_command)
end

def box?
  !capture_vagrant('box', 'list').grep(/^#{box_name}\s+\(libvirt,/).empty?
end

def domain_name
  "#{box_name}_default"
end

def clean_up_builder_vms
  libvirt = Libvirt.open('qemu:///system')

  clean_up_domain = proc do |domain|
    next if domain.nil?

    domain.destroy if domain.active?
    domain.undefine
    begin
      libvirt
        .lookup_storage_pool_by_name('default')
        .lookup_volume_by_name("#{domain.name}.img")
        .delete
    rescue Libvirt::RetrieveError
      # Expected if the pool or disk does not exist
    end
  end

  # Let's ensure that the VM we are about to create is cleaned up ...
  previous_domain = libvirt.list_all_domains.find { |d| d.name == domain_name }
  if previous_domain&.active?
    begin
      run_vagrant_ssh('mountpoint -q /var/cache/apt-cacher-ng')
    rescue VagrantCommandError
    # Nothing to unmount.
    else
      run_vagrant_ssh('sudo systemctl stop apt-cacher-ng.service')
      run_vagrant_ssh('sudo umount /var/cache/apt-cacher-ng')
      run_vagrant_ssh('sudo sync')
    end
    begin
      run_vagrant_ssh('mountpoint -q /var/cache/tails-website')
    rescue VagrantCommandError
    # Nothing to unmount.
    else
      run_vagrant_ssh('sudo umount /var/cache/tails-website')
      run_vagrant_ssh('sudo sync')
    end
  end
  clean_up_domain.call(previous_domain)

  # ... and the same for any residual VM based on another box (=>
  # another domain name) that Vagrant still keeps track of.
  old_domain =
    begin
      old_domain_uuid =
        open('vagrant/.vagrant/machines/default/libvirt/id', 'r', &:read)
        .strip
      libvirt.lookup_domain_by_uuid(old_domain_uuid)
    rescue Errno::ENOENT, Libvirt::RetrieveError
      # Expected if we don't have vagrant/.vagrant, or if the VM was
      # undefined for other reasons (e.g. manually).
      nil
    end
  clean_up_domain.call(old_domain)

  # We could use `vagrant destroy` here but due to vagrant-libvirt's
  # upstream issue #746 we then risk losing the apt-cacher-ng data.
  # Since we essentially implement `vagrant destroy` without this bug
  # above, but in a way so it works even if `vagrant/.vagrant` does
  # not exist, let's just do what is safest, i.e. avoiding `vagrant
  # destroy`. For details, see the upstream issue:
  #   https://github.com/vagrant-libvirt/vagrant-libvirt/issues/746
  FileUtils.rm_rf('vagrant/.vagrant')
ensure
  libvirt.close
end

desc 'Remove all libvirt volumes named tails-builder-* (run at your own risk!)'
task :clean_up_libvirt_volumes do
  libvirt = Libvirt.open('qemu:///system')
  begin
    pool = libvirt.lookup_storage_pool_by_name('default')
  rescue Libvirt::RetrieveError
    # Expected if the pool does not exist
  else
    pool.list_volumes.each do |disk|
      next unless /^tails-builder-/.match(disk)

      begin
        pool.lookup_volume_by_name(disk).delete
      rescue Libvirt::RetrieveError
        # Expected if the disk does not exist
      end
    end
  ensure
    libvirt.close
  end
end

def on_jenkins?
  !ENV['JENKINS_URL'].nil?
end

desc 'Clean up all build related files'
task clean_all: ['vm:destroy', 'basebox:clean_all']

namespace :vm do
  desc 'Start the build virtual machine'
  task up: [
    'parse_build_options',
    'ensure_enough_free_memory',
    'validate_http_proxy',
    'setup_environment',
    'basebox:create',
  ] do
    case vm_state
    when :not_created
      clean_up_builder_vms
    end
    begin
      run_vagrant('up', '--provision')
    rescue VagrantCommandError => e
      clean_up_builder_vms if $force_cleanup
      raise e
    end
  end

  desc 'SSH into the builder VM'
  task :ssh do
    run_vagrant('ssh')
  end

  desc 'Stop the build virtual machine'
  task :halt do
    run_vagrant('halt')
  end

  desc 'Re-run virtual machine setup'
  task provision: [
    'parse_build_options',
    'validate_http_proxy',
    'setup_environment',
  ] do
    run_vagrant('provision')
  end

  desc 'Destroy build virtual machine (clean up all files except the ' \
       "vmproxy's apt-cacher-ng data and the website cache)"
  task :destroy do
    clean_up_builder_vms
  end
end

namespace :basebox do
  desc 'Create and import the base box unless already done'
  task :create do
    next if box?

    warn <<-END_OF_MESSAGE.gsub(/^      /, '')

      This is the first time we are using this Vagrant base box so we
      will have to bootstrap by building it from scratch. This will
      take around 20 minutes (depending on your hardware) plus the
      time needed for downloading around 250 MiB of Debian packages.

    END_OF_MESSAGE
    run_command(
      "#{VAGRANT_PATH}/definitions/tails-builder/generate-tails-builder-box.sh"
    )
    box_dir = Dir.pwd
    # Let's use an absolute path since run_vagrant changes the working
    # directory but File.delete doesn't
    box_path = "#{box_dir}/#{box_name}.box"
    run_vagrant('box', 'add', '--name', box_name, box_path)
    File.delete(box_path)
  end

  def basebox_date(box)
    Date.parse(/^tails-builder-[^-]+-[^-]+-(\d{8})/.match(box)[1])
  end

  def baseboxes
    capture_vagrant('box', 'list')
      .first.lines
      .grep(/^tails-builder-.*/)
      .map { |x| x.chomp.sub(/\s.*$/, '') }
  end

  def clean_up_basebox(box)
    run_vagrant('box', 'remove', '--force', box)
    begin
      libvirt = Libvirt.open('qemu:///system')
      libvirt
        .lookup_storage_pool_by_name('default')
        .lookup_volume_by_name("#{box}_vagrant_box_image_0.img")
        .delete
    rescue Libvirt::RetrieveError
      # Expected if the pool or disk does not exist
    ensure
      libvirt.close
    end
  end

  desc 'Remove all base boxes'
  task :clean_all do
    baseboxes.each { |box| clean_up_basebox(box) }
  end

  desc 'Remove all base boxes older than six months'
  task :clean_old do
    boxes = baseboxes
    # We always want to keep the newest basebox
    boxes.sort! { |a, b| basebox_date(a) <=> basebox_date(b) }
    boxes.pop
    boxes.each do |box|
      clean_up_basebox(box) if basebox_date(box) < Date.today - 365.0 / 2.0
    end
  end
end
