import PropTypes from 'prop-types';
import React, { useCallback, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExtensionManager, useToolbar } from '@ohif/core';

import { setTrackingUniqueIdentifiersForElement } from '../tools/modules/dicomSRModule';

import { ViewportActionArrows } from '@ohif/ui-next';
import createReferencedImageDisplaySet from '../utils/createReferencedImageDisplaySet';
import { usePositionPresentationStore } from '@ohif/extension-cornerstone';
import { useViewportGrid } from '@ohif/ui-next';
import { Icons, Tooltip, TooltipTrigger, TooltipContent } from '@ohif/ui-next';

const MEASUREMENT_TRACKING_EXTENSION_ID = '@ohif/extension-measurement-tracking';

const SR_TOOLGROUP_BASE_NAME = 'SRToolGroup';

function OHIFCornerstoneSRMeasurementViewport(props: withAppTypes) {
  const { children, dataSource, displaySets, viewportOptions, servicesManager, extensionManager } =
    props;

  const { displaySetService, viewportActionCornersService } = servicesManager.services;

  const viewportId = viewportOptions.viewportId;

  // SR viewport will always have a single display set
  if (displaySets.length > 1) {
    throw new Error('SR viewport should only have a single display set');
  }

  const srDisplaySet = displaySets[0];

  const { setPositionPresentation } = usePositionPresentationStore();

  const [viewportGrid, viewportGridService] = useViewportGrid();
  const [measurementSelected, setMeasurementSelected] = useState(0);
  const [measurementCount, setMeasurementCount] = useState(1);
  const [activeImageDisplaySetData, setActiveImageDisplaySetData] = useState(null);
  const [referencedDisplaySetMetadata, setReferencedDisplaySetMetadata] = useState(null);
  const [element, setElement] = useState(null);
  const { viewports, activeViewportId } = viewportGrid;

  const { t } = useTranslation('Common');

  // Optional hook into tracking extension, if present.
  let trackedMeasurements;

  const hasMeasurementTrackingExtension = extensionManager.registeredExtensionIds.includes(
    MEASUREMENT_TRACKING_EXTENSION_ID
  );

  if (hasMeasurementTrackingExtension) {
    const contextModule = extensionManager.getModuleEntry(
      '@ohif/extension-measurement-tracking.contextModule.TrackedMeasurementsContext'
    );

    const tracked = useContext(contextModule.context);
    trackedMeasurements = tracked?.[0];
  }

  /**
   * Todo: what is this, not sure what it does regarding the react aspect,
   * it is updating a local variable? which is not state.
   */
  const [isLocked, setIsLocked] = useState(trackedMeasurements?.context?.trackedSeries?.length > 0);
  /**
   * Store the tracking identifiers per viewport in order to be able to
   * show the SR measurements on the referenced image on the correct viewport,
   * when multiple viewports are used.
   */
  const setTrackingIdentifiers = useCallback(
    measurementSelected => {
      const { measurements } = srDisplaySet;

      setTrackingUniqueIdentifiersForElement(
        element,
        measurements.map(measurement => measurement.TrackingUniqueIdentifier),
        measurementSelected
      );
    },
    [element, measurementSelected, srDisplaySet]
  );

  /**
   * OnElementEnabled callback which is called after the cornerstoneExtension
   * has enabled the element. Note: we delegate all the image rendering to
   * cornerstoneExtension, so we don't need to do anything here regarding
   * the image rendering, element enabling etc.
   */
  const onElementEnabled = evt => {
    setElement(evt.detail.element);
  };

  const updateViewport = useCallback(
    newMeasurementSelected => {
      const { StudyInstanceUID, displaySetInstanceUID, sopClassUids } = srDisplaySet;

      if (!StudyInstanceUID || !displaySetInstanceUID) {
        return;
      }

      if (sopClassUids && sopClassUids.length > 1) {
        // Todo: what happens if there are multiple SOP Classes? Why we are
        // not throwing an error?
        console.warn('More than one SOPClassUID in the same series is not yet supported.');
      }

      // if (!srDisplaySet.measurements || !srDisplaySet.measurements.length) {
      //   return;
      // }

      _getViewportReferencedDisplaySetData(
        srDisplaySet,
        newMeasurementSelected,
        displaySetService
      ).then(({ referencedDisplaySet, referencedDisplaySetMetadata }) => {
        if (!referencedDisplaySet || !referencedDisplaySetMetadata) {
          return;
        }

        setMeasurementSelected(newMeasurementSelected);

        setActiveImageDisplaySetData(referencedDisplaySet);
        setReferencedDisplaySetMetadata(referencedDisplaySetMetadata);

        const { presentationIds } = viewportOptions;
        const measurement = srDisplaySet.measurements[newMeasurementSelected];
        setPositionPresentation(presentationIds.positionPresentationId, {
          viewReference: {
            referencedImageId: measurement.imageId,
          },
        });
      });
    },
    [dataSource, srDisplaySet, activeImageDisplaySetData, viewportId]
  );

  const getCornerstoneViewport = useCallback(() => {
    if (!activeImageDisplaySetData) {
      return null;
    }

    const { component: Component } = extensionManager.getModuleEntry(
      '@ohif/extension-cornerstone.viewportModule.cornerstone'
    );

    const { measurements } = srDisplaySet;
    const measurement = measurements[measurementSelected];

    if (!measurement) {
      return null;
    }

    return (
      <Component
        {...props}
        // should be passed second since we don't want SR displaySet to
        // override the activeImageDisplaySetData
        displaySets={[activeImageDisplaySetData]}
        // It is possible that there is a hanging protocol applying viewportOptions
        // for the SR, so inherit the viewport options
        // TODO: Ensure the viewport options are set correctly with respect to
        // stack etc, in the incoming viewport options.
        viewportOptions={{
          ...viewportOptions,
          toolGroupId: `${SR_TOOLGROUP_BASE_NAME}`,
          // viewportType should not be required, as the stack type should be
          // required already in order to view SR, but sometimes segmentation
          // views set the viewport type without fixing the allowed display
          viewportType: 'stack',
          // The positionIds for the viewport aren't meaningful for the child display sets
          positionIds: null,
        }}
        onElementEnabled={evt => {
          props.onElementEnabled?.(evt);
          onElementEnabled(evt);
        }}
        isJumpToMeasurementDisabled={true}
      ></Component>
    );
  }, [activeImageDisplaySetData, viewportId, measurementSelected]);

  const onMeasurementChange = useCallback(
    direction => {
      let newMeasurementSelected = measurementSelected;

      newMeasurementSelected += direction;
      if (newMeasurementSelected >= measurementCount) {
        newMeasurementSelected = 0;
      } else if (newMeasurementSelected < 0) {
        newMeasurementSelected = measurementCount - 1;
      }

      setTrackingIdentifiers(newMeasurementSelected);
      updateViewport(newMeasurementSelected);
    },
    [measurementSelected, measurementCount, updateViewport, setTrackingIdentifiers]
  );

  /**
   Cleanup the SR viewport when the viewport is destroyed
   */
  useEffect(() => {
    const onDisplaySetsRemovedSubscription = displaySetService.subscribe(
      displaySetService.EVENTS.DISPLAY_SETS_REMOVED,
      ({ displaySetInstanceUIDs }) => {
        const activeViewport = viewports.get(activeViewportId);
        if (displaySetInstanceUIDs.includes(activeViewport.displaySetInstanceUID)) {
          viewportGridService.setDisplaySetsForViewport({
            viewportId: activeViewportId,
            displaySetInstanceUIDs: [],
          });
        }
      }
    );

    return () => {
      onDisplaySetsRemovedSubscription.unsubscribe();
    };
  }, []);

  /**
   * Loading the measurements from the SR viewport, which goes through the
   * isHydratable check, the outcome for the isHydrated state here is always FALSE
   * since we don't do the hydration here. Todo: can't we just set it as false? why
   * we are changing the state here? isHydrated is always false at this stage, and
   * if it is hydrated we don't even use the SR viewport.
   */
  useEffect(() => {
    const loadSR = async () => {
      if (!srDisplaySet.isLoaded) {
        await srDisplaySet.load();
      }
      const numMeasurements = srDisplaySet.measurements.length;
      setMeasurementCount(numMeasurements);
      updateViewport(measurementSelected);
    };
    loadSR();
  }, [srDisplaySet]);

  /**
   * Hook to update the tracking identifiers when the selected measurement changes or
   * the element changes
   */
  useEffect(() => {
    const updateSR = async () => {
      if (!srDisplaySet.isLoaded) {
        await srDisplaySet.load();
      }
      if (!element || !srDisplaySet.isLoaded) {
        return;
      }
      setTrackingIdentifiers(measurementSelected);
    };
    updateSR();
  }, [measurementSelected, element, setTrackingIdentifiers, srDisplaySet]);

  useEffect(() => {
    setIsLocked(trackedMeasurements?.context?.trackedSeries?.length > 0);
  }, [trackedMeasurements]);

  useEffect(() => {
    viewportActionCornersService.addComponents([
      {
        viewportId,
        id: 'viewportStatusComponent',
        component: _getStatusComponent({
          srDisplaySet,
          viewportId,
          isRehydratable: srDisplaySet.isRehydratable,
          isLocked,
          t,
          servicesManager,
        }),
        indexPriority: -100,
        location: viewportActionCornersService.LOCATIONS.topRight,
      },
      {
        viewportId,
        id: 'viewportActionArrowsComponent',
        index: 0,
        component: (
          <ViewportActionArrows
            key="actionArrows"
            onArrowsClick={onMeasurementChange}
          ></ViewportActionArrows>
        ),
        indexPriority: 0,
        location: viewportActionCornersService.LOCATIONS.topRight,
      },
    ]);
  }, [isLocked, onMeasurementChange, srDisplaySet, t, viewportActionCornersService, viewportId]);

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  let childrenWithProps = null;

  if (!activeImageDisplaySetData || !referencedDisplaySetMetadata) {
    return null;
  }

  if (children && children.length) {
    childrenWithProps = children.map((child, index) => {
      return (
        child &&
        React.cloneElement(child, {
          viewportId,
          key: index,
        })
      );
    });
  }

  return (
    <>
      <div className="relative flex h-full w-full flex-row overflow-hidden">
        {getCornerstoneViewport()}
        {childrenWithProps}
      </div>
    </>
  );
}

OHIFCornerstoneSRMeasurementViewport.propTypes = {
  displaySets: PropTypes.arrayOf(PropTypes.object),
  viewportId: PropTypes.string.isRequired,
  dataSource: PropTypes.object,
  children: PropTypes.node,
  viewportLabel: PropTypes.string,
  viewportOptions: PropTypes.object,
  servicesManager: PropTypes.object.isRequired,
  extensionManager: PropTypes.instanceOf(ExtensionManager).isRequired,
};

async function _getViewportReferencedDisplaySetData(
  displaySet,
  measurementSelected,
  displaySetService
) {
  const { measurements } = displaySet;
  const measurement = measurements[measurementSelected];

  const { displaySetInstanceUID } = measurement;
  if (!displaySet.keyImageDisplaySet) {
    // Create a new display set, and preserve a reference to it here,
    // so that it can be re-displayed and shown inside the SR viewport.
    // This is only for ease of redisplay - the display set is stored in the
    // usual manner in the display set service.
    displaySet.keyImageDisplaySet = createReferencedImageDisplaySet(displaySetService, displaySet);
  }

  if (!displaySetInstanceUID) {
    return { referencedDisplaySetMetadata: null, referencedDisplaySet: null };
  }

  const referencedDisplaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

  const image0 = referencedDisplaySet.images[0];
  const referencedDisplaySetMetadata = {
    PatientID: image0.PatientID,
    PatientName: image0.PatientName,
    PatientSex: image0.PatientSex,
    PatientAge: image0.PatientAge,
    SliceThickness: image0.SliceThickness,
    StudyDate: image0.StudyDate,
    SeriesDescription: image0.SeriesDescription,
    SeriesInstanceUID: image0.SeriesInstanceUID,
    SeriesNumber: image0.SeriesNumber,
    ManufacturerModelName: image0.ManufacturerModelName,
    SpacingBetweenSlices: image0.SpacingBetweenSlices,
  };

  return { referencedDisplaySetMetadata, referencedDisplaySet };
}

function _getStatusComponent({
  srDisplaySet,
  viewportId,
  isRehydratable,
  isLocked,
  t,
  servicesManager,
}) {
  const loadStr = t('LOAD');

  // 1 - Incompatible
  // 2 - Locked
  // 3 - Rehydratable / Open
  const state = isRehydratable && !isLocked ? 3 : isRehydratable && isLocked ? 2 : 1;
  let ToolTipMessage = null;
  let StatusIcon = null;

  switch (state) {
    case 1:
      StatusIcon = () => (
        <Icons.ByName
          name="status-alert"
          className="h-4 w-4"
        />
      );

      ToolTipMessage = () => (
        <div>
          This structured report is not compatible
          <br />
          with this application.
        </div>
      );
      break;
    case 2:
      StatusIcon = () => (
        <Icons.ByName
          name="status-locked"
          className="h-4 w-4"
        />
      );

      ToolTipMessage = () => (
        <div>
          This structured report is currently read-only
          <br />
          because you are tracking measurements in
          <br />
          another viewport.
        </div>
      );
      break;
    case 3:
      StatusIcon = () => (
        <Icons.ByName
          className="text-muted-foreground h-4 w-4"
          name="status-untracked"
        />
      );

      ToolTipMessage = () => <div>{`Click ${loadStr} to restore measurements.`}</div>;
  }

  const StatusArea = () => {
    const { toolbarButtons: loadSRMeasurementsButtons, onInteraction } = useToolbar({
      servicesManager,
      buttonSection: 'loadSRMeasurements',
    });

    const commandOptions = {
      displaySetInstanceUID: srDisplaySet.displaySetInstanceUID,
      viewportId,
    };

    return (
      <div className="flex h-6 cursor-default text-sm leading-6 text-white">
        <div className="bg-customgray-100 flex min-w-[45px] items-center rounded-l-xl rounded-r p-1">
          <StatusIcon className="h-4 w-4" />
          <span className="ml-1">SR</span>
        </div>
        {state === 3 && (
          <>
            {loadSRMeasurementsButtons.map(toolDef => {
              if (!toolDef) {
                return null;
              }
              const { id, Component, componentProps } = toolDef;
              const tool = (
                <Component
                  key={id}
                  id={id}
                  onInteraction={args => onInteraction({ ...args, ...commandOptions })}
                  {...componentProps}
                />
              );

              return <div key={id}>{tool}</div>;
            })}
          </>
        )}
      </div>
    );
  };

  return (
    <>
      {ToolTipMessage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <StatusArea />
            </span>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="start"
          >
            <ToolTipMessage />
          </TooltipContent>
        </Tooltip>
      )}
      {!ToolTipMessage && <StatusArea />}
    </>
  );
}

export default OHIFCornerstoneSRMeasurementViewport;
