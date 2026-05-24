=head1 NAME

Tails::HasDBus::System - role providing a connection to the system DBus

=cut

package Tails::Role::HasDBus::System;

use 5.10.1;
use strictures 2;
use autodie qw(:all);

use Carp::Assert::More;
use Function::Parameters;
use Net::DBus qw(:typing);
use Net::DBus::GLib;
use Types::Standard qw{InstanceOf};

use Moo::Role;
use namespace::clean;

has 'dbus'  => (
    isa        => InstanceOf['Net::DBus'],
    is         => 'ro',
    required   => 1,
    builder    => '_build_dbus',
);

method _build_dbus () {
    my $dbus = Net::DBus::GLib->system;
    assert_defined($dbus);
    return $dbus;
}

no Moo::Role;
1; # End of Tails::HasDBus::System
