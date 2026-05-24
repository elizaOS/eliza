=head1 NAME

Tails::UDisks - role providing a connection to UDisks via DBus

=cut

package Tails::UDisks;

use 5.10.1;
use strictures 2;
use autodie qw(:all);

use Carp::Assert::More;
use File::stat;
use Function::Parameters;
use IPC::System::Simple qw{capturex};
use Syntax::Keyword::Junction qw{any};
use List::Util qw{first};
use Tails::Constants;
use Types::Standard qw{ArrayRef Defined InstanceOf Str};
use Types::Path::Tiny qw{Path};
use Unix::Mknod qw(:all);

no Moo::sification;
use Moo;
use namespace::clean;

with 'Tails::Role::HasDBus::System';

has 'constants' => (
    is         => 'lazy',
    isa        => InstanceOf['Tails::Constants'],
    handles    => [ qw{system_partition_label}],
);

has 'udisks_service' => (
    is         => 'lazy', # Let's decide the right initialization order in BUILD
    isa        => InstanceOf['Net::DBus::RemoteService'],
);

has 'udisks_object' => (
    is         => 'lazy', # Let's decide the right initialization order in BUILD
    isa        => InstanceOf['Net::DBus::RemoteObject'],
);

method BUILD (@args) {
    # Force initialization in correct order
    assert_defined($self->dbus);
    assert_defined($self->udisks_service);
    assert_defined($self->udisks_object);
}

method _build_constants () {
    Tails::Constants->new();
}

method _build_udisks_service () {
    $self->dbus->get_service("org.freedesktop.UDisks2");
}

method _build_udisks_object () {
    $self->udisks_service->get_object(
        "/org/freedesktop/UDisks2",
        "org.freedesktop.DBus.ObjectManager"
    );
}

method debug (@args) {
    say STDERR @args if $ENV{DEBUG};
}

method get_udisks_property (Str $type, Defined $object, Str $property) {
    $self->debug("Entering get_udisks_property: $type, $object, $property");
    $self->udisks_service
         ->get_object($object)
         ->as_interface("org.freedesktop.DBus.Properties")
         ->Get("org.freedesktop.UDisks2.$type", $property);
}

method get_block_device_property (Defined $device, Str $property) {
    $self->get_udisks_property('Block', $device, $property);
}

method get_drive_property (Defined $drive, Str $property) {
    $self->get_udisks_property('Drive', $drive, $property);
}

method get_partition_table_property (Defined $device, Str $property) {
    $self->get_udisks_property('PartitionTable', $device, $property);
}

method get_partition_property (Defined $device, Str $property) {
    $self->get_udisks_property('Partition', $device, $property);
}

method get_filesystem_property (Defined $device, Str $property) {
    $self->get_udisks_property('Filesystem', $device, $property);
}

method drive_is_connected_via_a_supported_interface (Defined $drive) {
    $self->debug("Entering drive_is_connected_via_a_supported_interface, $drive");

    my $iface = $self->get_drive_property($drive, 'ConnectionBus');

    any(qw{sdio usb}) eq $iface;
}

method drive_is_optical (Defined $drive) {
    $self->get_drive_property($drive, 'Optical');
}

method partitions (Defined $device) {
    my $partition_re;
    if ($device =~ m{mmcblk [0-9]+ \z}xms) {
        $partition_re = qr{\A$device[p][0-9]+\z};
    }
    else {
        $partition_re = qr{\A$device[0-9]+\z};
    }

    grep {
        $_ =~ m{$partition_re}xms
    } keys %{$self->udisks_object->GetManagedObjects()};
}

method luks_holder (Defined $device) {
    my %objects = %{$self->udisks_object->GetManagedObjects()};

    first {
        my $obj = $objects{$_};
        return unless exists($obj->{'org.freedesktop.UDisks2.Block'});
        return unless defined($obj->{'org.freedesktop.UDisks2.Block'});
        my $block = $obj->{'org.freedesktop.UDisks2.Block'};
        return unless exists($block->{CryptoBackingDevice});
        return unless defined($block->{CryptoBackingDevice});
        $block->{CryptoBackingDevice} eq $device;
    } keys %objects;
}

method bytes_array_to_string (ArrayRef $bytes_array) {
    my @bytes_array = @{$bytes_array};
    my $null_terminated_str = pack('(U)*x', @bytes_array);
    return substr($null_terminated_str, 0, length($null_terminated_str) - 2);
}

method mountpoints (Defined $device) {
    my $luks_holder = $self->luks_holder($device);
    my $real_device = $luks_holder ? $luks_holder : $device;

    return map {
        $self->bytes_array_to_string($_)
    } @{$self->get_filesystem_property($real_device, 'MountPoints')};
}

method device_partition_with_label (Defined $device, Str $label) {
    $self->debug("Entering device_partition_with_label $device, $label");
    first {
        defined && $label eq $self->get_partition_property($_, 'Name')
    } $self->partitions($device)
}

method device_has_partition_with_label (Defined $device, Str $label) {
    defined $self->device_partition_with_label($device, $label);
}

method device_installed_with_tails_installer (Defined $device) {
    $self->debug("Entering device_installed_with_tails_installer: $device");
    'gpt' eq $self->get_partition_table_property($device, 'Type')
        or return;

    $self->device_has_partition_with_label($device, $self->system_partition_label)
        or return;

    return 1;
}


=head2 underlying_block_device

Returns the physical block device UDI (e.g.
/org/freedesktop/UDisks2/block_devices/sdb1) on which the specified file
is stored.

=cut
method underlying_block_device (Path $path) {
    say STDERR "Entering underlying_block_device ($path)";
    my $st     = stat($path);

    my $device = capturex(
        'readlink', '--canonicalize',
        sprintf("/dev/block/%i:%i", major($st->dev), minor($st->dev))
    );
    say STDERR "readlink returned: $device";
    $device =~ s{\A /dev/}{}xms;
    $device =~ s{\n \z}{}xms;
    $device = "/org/freedesktop/UDisks2/block_devices/$device";

    say STDERR "Leaving underlying_block_device, returning: $device";
    return $device;
}

=head2 underlying_drive

Returns the physical drive UDI (e.g.
/org/freedesktop/UDisks2/drives/Verbatim_ABC_2786) on which the specified file
is stored.

=cut
method underlying_drive (Path $path) {
    $self->debug("Entering underlying_drive");
    my $block = $self->underlying_block_device($path);
    $self->debug("block: $block");
    my $drive = $self->get_block_device_property($block, 'Drive');
    # assert_defined($drive);
    $self->debug("drive: $drive");
    return $drive;
}

no Moo;
1; # End of Tails::UDisks
