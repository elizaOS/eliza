# -*- mode: ruby -*-
# vi: set ft=ruby :

# Virtual machine memory size for on-disk builds:
# approximate amount of RAM needed to run the builder's base system
# and perform a build
def vm_memory_for_disk_builds(cpus)
  memory = 1.85 * 1024
  # mksquashfs will run one thread per CPU, and each of them uses more
  # RAM, especially when defaulcomp (xz) is used. We only adjust when
  # there are many CPUs since that's the only situation where we have
  # observed this kind of RAM shortage.
  memory += cpus * 50
  memory
end

# Virtual machine memory size for in-memory builds
# Please note that we aren't even trying to make this accurate for anything other
# than our Jenkins instance. If you're building from RAM, we assume you are setting
# $TAILS_BUILD_MEMORY in your environment.
def vm_memory_for_ram_builds
  17000
end

# The builder VM's platform
ARCHITECTURE = 'amd64'.freeze
DISTRIBUTION = 'trixie'.freeze

# The name of the Vagrant box
def box_name
  git_root = `git rev-parse --show-toplevel`.chomp
  shortid, date = `git log -1 --date="format:%Y%m%d" \
                   --no-show-signature --pretty="%h %ad" -- \
                   #{git_root}/vagrant/definitions/tails-builder/`.chomp.split
  "tails-builder-#{ARCHITECTURE}-#{DISTRIBUTION}-#{date}-#{shortid}"
end
