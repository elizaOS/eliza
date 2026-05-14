=head1 NAME

Tails::IUK::Read - read Incremental Upgrade Kit files

=cut

package Tails::IUK::Read;

no Moo::sification;
use Moo;
use MooX::HandlesVia;

use 5.10.1;
use strictures 2;

use autodie qw(:all);
use Carp;
use Carp::Assert;
use Cwd;
use Data::Dumper;
use File::Temp;
use Function::Parameters;
use List::Util qw{sum};
use Path::Tiny;
use Try::Tiny;
use YAML::Any;
use Tails::IUK::Utils qw{directory_size run_as_root};
use Types::Path::Tiny qw{AbsDir AbsFile Path};
use Types::Standard qw{ArrayRef ClassName HashRef InstanceOf Str};

use namespace::clean;


=head1 ATTRIBUTES

=cut

has 'file' => (
    isa      => AbsFile,
    required => 1,
    is       => 'ro',
);

has 'format_version' =>
    is  => 'lazy',
    isa => Str;

has 'control' =>
    is  => 'lazy',
    isa => HashRef;

has 'delete_files'   =>
    is          => 'lazy',
    isa         => ArrayRef,
    handles_via => 'Array',
    handles     => {
        delete_files_count => "count",
    };

has 'files' =>
    is  => 'lazy',
    isa => ArrayRef;

has 'mountpoint' =>
    is        => 'lazy',
    isa       => AbsDir,
    predicate => 1;

=head1 METHODS

=cut

method _build_mountpoint () {
    my $mountpoint = path(File::Temp::tempdir(CLEANUP => 0));
    run_as_root('mount', $self->file, $mountpoint);
    return $mountpoint;
}

method _build_format_version () {
    my $format_version;
    try {
        $format_version = $self->get_content(path('FORMAT'));
    } catch {
        croak "The format version cannot be determined:\n$_";
    };
    return $format_version;
}

method _build_delete_files () {
    my $delete_files = $self->control->{delete_files};
    $delete_files ||= [];
    return $delete_files;
}

method _build_control () {
    my $control = YAML::Any::Load($self->get_content(path('control.yml')));
    $control = {} unless defined $control;
    return $control;
}

method _build_files () { [ $self->archive->files ] }

method BUILD (@args) {
    my $format_version;
    try {
        $format_version = $self->format_version();
    } catch {
        croak "The format version cannot be determined:\n$_";
    };
    $format_version eq '2'
        or croak(sprintf("Unsupported format: %s", $format_version));
}

fun new_from_file (ClassName $class, AbsFile $filename, @rest) {
    return $class->new(
        file => path($filename),
        @rest,
    );
}

method clean () {
    run_as_root('umount', $self->mountpoint) if $self->has_mountpoint;
}

method DEMOLISH (@args) {
    $self->clean;
}

method get_content (Path $filename) {
    $self->mountpoint->child($filename)->slurp;
}

method list_files () {
    my @files;
    my $iter = $self->mountpoint->iterator({ recurse => 1 });
    while (my $path = $iter->()) {
        push @files, $path->relative($self->mountpoint);
    }
    return @files;
}

method overlay_dir () {
    $self->mountpoint->child('overlay');
}

method space_needed () {
    $self->overlay_dir->exists ? directory_size($self->overlay_dir) : 0;
}

method contains_file (Path $filename) {
    1 == grep { $_ eq $filename } $self->list_files;
}

method squashfs_in_overlay () {
    return unless $self->overlay_dir->child('live')->exists;
    map {
        $_->basename
    } grep {
        -f $_
    } $self->overlay_dir->child('live')->children(qr/[.]squashfs\z/);
}

no Moo;
1;
