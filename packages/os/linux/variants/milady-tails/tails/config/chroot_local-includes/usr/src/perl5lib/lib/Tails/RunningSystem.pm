=head1 NAME

Tails::RunningSystem - class that represents the running Tails system

=cut

package Tails::RunningSystem;

use 5.10.1;
use strictures 2;
use autodie qw(:all);

use Carp;
use Carp::Assert;
use Carp::Assert::More;
use Function::Parameters;
use Path::Tiny;
use Sys::Statistics::Linux::MemStats;
use Tails::Constants;
use Tails::UDisks;
use Try::Tiny;
use Types::Path::Tiny qw{AbsDir AbsFile AbsPath};
use Types::Standard qw(InstanceOf Int Str);

use Locale::TextDomain 'tails';

no Moo::sification;
use Moo;

with 'Tails::Role::HasEncoding';
with 'Tails::Role::DisplayError::Gtk3';

use namespace::clean;


=head1 ATTRIBUTES

=cut

has 'upgrade_description_url_schema_version' => (
    is         => 'lazy',
    isa        => Int,
);

has "$_" => (
    is         => 'lazy',
    isa        => Str,
) for (
        qw{baseurl product_name initial_install_version product_version},
        qw{build_target channel},
        qw{upgrade_description_file_url upgrade_description_sig_url},
    );

has initial_install_os_release_file => (
    isa        => AbsFile,
    coerce     => AbsFile->coercion,
    is         => 'lazy',
);

has os_release_file => (
    isa        => AbsFile,
    coerce     => AbsFile->coercion,
    is         => 'lazy',
);

has "$_" => (
    isa        => AbsDir,
    is         => 'lazy',
) for (qw{dev_dir proc_dir run_dir});

has 'udisks' => (
    is         => 'lazy',
    isa        => InstanceOf['Tails::UDisks'],
    handles    => [ qw{bytes_array_to_string device_installed_with_tails_installer
                       get_block_device_property get_drive_property
                       get_partition_property
                       underlying_block_device underlying_drive} ],
);

has 'liveos_mountpoint' => (
    isa        => AbsDir,
    is         => 'lazy',
    coerce     => AbsDir->coercion,
    documentation => q{Mountpoint of the Tails system image.},
);

has 'boot_drive' => (
    is            => 'lazy',
    isa           => Str,
    documentation => q{The UDI of the physical drive where Tails is installed, e.g. /org/freedesktop/UDisks2/drives/Verbatim_ABC_2786.},
);

has 'boot_block_device' => (
    is            => 'lazy',
    isa           => Str,
    documentation => q{The UDI of the block device where Tails is installed, e.g. /org/freedesktop/UDisks2/block_devices/sdb.}
);

has 'boot_device_file' => (
    is            => 'lazy',
    isa           => AbsPath,
    coerce        => AbsPath->coercion,
    documentation => q{The path of the physical drive where Tails is installed, e.g. /dev/sdb.},
);

has 'system_partition' => (
    is            => 'lazy',
    isa           => Str,
    documentation => q{The UDI of the partition where Tails is installed, e.g. /org/freedesktop/UDisks2/block_devices/sdb1.},
);

has 'system_partition_file' => (
    is            => 'lazy',
    isa           => AbsPath,
    coerce        => AbsPath->coercion,
    documentation => q{The path of the partition where Tails is installed, e.g. /dev/sdb1.},
);

has 'constants' => (
    is         => 'lazy',
    isa        => InstanceOf['Tails::Constants'],
    handles    => [ qw{system_partition_label}],
);

has 'main_window' => (
    is  => 'ro',
    isa => InstanceOf['Gtk3::Window'],
);

foreach (qw{boot_drive_vendor boot_drive_model
            override_started_from_device_installed_with_tails_installer}) {
    has $_ => (
        is         => 'lazy',
        isa        => Str,
        predicate  => 1,
    );
}


=head1 CONSTRUCTORS AND BUILDERS

=cut

method _build_upgrade_description_url_schema_version () { 2 }
method _build_dev_dir () { path('/dev') }
method _build_os_release_file () { path('/etc/os-release') }
method _build_initial_install_os_release_file () {
    path('/lib/live/mount/rootfs/filesystem.squashfs/etc/os-release')
}
method _build_proc_dir () { path('/proc') }
method _build_run_dir () { path('/var/run') }
method _build_product_name () { $self->os_release_get('NAME') }
method _build_product_version () { $self->os_release_get('VERSION') }
method _build_initial_install_version () {
    $self->os_release_get(
        'VERSION',
        'os_release_file' => $self->initial_install_os_release_file,
    )
}
method _build_baseurl () { 'https://tails.net' }
method _build_udisks () { Tails::UDisks->new(); }

method _build_build_target () {
    my $arch = `dpkg --print-architecture`; chomp $arch; return $arch;
}

method _build_channel () {
    my $channel;
    try { $channel = $self->os_release_get('TAILS_CHANNEL') };
    defined $channel ? $channel : 'stable';
}

method _build_upgrade_description_file_url () {
    sprintf(
        "%s/upgrade/v%d/%s/%s/%s/%s/upgrades.yml",
        $self->baseurl,
        $self->upgrade_description_url_schema_version,
        $self->product_name,
        $self->initial_install_version,
        $self->build_target,
        $self->channel,
    );
}

method _build_upgrade_description_sig_url () {
    $self->upgrade_description_file_url . '.pgp';
}

method _build_constants () {
    Tails::Constants->new();
}

method _build_liveos_mountpoint () {
    path('/lib/live/mount/medium');
}

method _build_boot_block_device () {
    my $device;
    try {
        say STDERR "_build_boot_block_device: getting liveos_mountpoint";
        my $liveos_mountpoint = $self->liveos_mountpoint;
        say STDERR "liveos_mountpoint: $liveos_mountpoint";
        $device = $self->underlying_block_device($liveos_mountpoint);
    } catch {
        $self->display_error(
            $self->main_window,
            __(q{Error}),
            __(
                q{The device Tails is running from cannot be found. Maybe you used the 'toram' option?},
            ),
        );
    };

    assert_defined($device);

    # E.g. optical drives have no org.freedesktop.UDisks2.Partition interface,
    # so let's try to find out the parent device, and fallback to the device
    # itself.
    my $parent_device;
    try {
        $parent_device = $self->get_partition_property($device, 'Table');
    };
    my $boot_block_device = $parent_device ? $parent_device : $device;

    say STDERR "boot device: $boot_block_device" if $ENV{DEBUG};
    return $boot_block_device;
}

method _build_boot_drive () {
    my $drive;
    try {
        $drive = $self->underlying_drive($self->liveos_mountpoint);
    } catch {
        $self->display_error(
            $self->main_window,
            __(
                q{The drive Tails is running from cannot be found. Maybe you used the 'toram' option?},
            ),
            '',
        );
    };

    assert_defined($drive);
    say STDERR "boot drive: $drive" if $ENV{DEBUG};
    return $drive;
}

method _build_boot_device_file () {
    return $self->bytes_array_to_string($self->get_block_device_property(
        $self->boot_block_device, 'PreferredDevice'
    ));
}

method _build_system_partition () {
    $self->udisks->device_partition_with_label(
        $self->boot_block_device,
        $self->system_partition_label
    );
}

method _build_system_partition_file () {
    return $self->bytes_array_to_string($self->get_block_device_property(
        $self->system_partition, 'PreferredDevice'
    ));
}

method _build_boot_drive_vendor () {
    $self->get_drive_property($self->boot_drive, 'Vendor');
}

method _build_boot_drive_model () {
    $self->get_drive_property($self->boot_drive, 'Model');
}


=head1 METHODS

=cut

=head2 os_release_get

Retrieve a value from os-release file,
as specified by
http://www.freedesktop.org/software/systemd/man/os-release.html

Throws an exception if not found.

=cut
method os_release_get (Str $key, AbsFile :$os_release_file = $self->os_release_file) {
    assert(-e $os_release_file);
    assert_like($key, qr{[_A-Z]+});

    my $fh = path($os_release_file)->openr;

    while (<$fh>) {
        chomp;
        if (my ($value) = (m{\A $key [=] ["] (.*) ["] \z}xms)) {
            return $value;
        }
    }

    croak(sprintf(
        "Could not retrieve value of '%s' in '%s'",
        $key, $os_release_file,
    ));
}

method started_from_device_installed_with_tails_installer () {
    return $self->override_started_from_device_installed_with_tails_installer
        if $self->has_override_started_from_device_installed_with_tails_installer;
    $self->device_installed_with_tails_installer($self->boot_block_device);
}

method started_from_writable_device () {
    assert(-d $self->dev_dir);

    -e path($self->dev_dir, 'bilibop');
}

=head2 free_memory

Returns MemFree + Buffers + Cached, in bytes.

=cut
method free_memory () {
    assert(-d $self->proc_dir);
    assert(-e path($self->proc_dir, 'meminfo'));

    Sys::Statistics::Linux::MemStats->new(
        files => { path => $self->proc_dir }
    )->get->{realfree} * 1024;
}

no Moo;
1;
