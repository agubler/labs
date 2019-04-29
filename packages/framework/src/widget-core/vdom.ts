import global from '@dojo/framework/shim/global';
import has from '@dojo/framework/has/has';
import { WeakMap } from '@dojo/framework/shim/WeakMap';
import { Map } from '@dojo/framework/shim/Map';
import { Set } from '@dojo/framework/shim/Set';
import transitionStrategy from '@dojo/framework/widget-core/animations/cssTransitions';
import { isVNode, isWNode, WNODE, v, w, VNODE, widget, isWidget, isDomVNode } from './tsx';
import { Registry, isWidgetBaseConstructor } from '@dojo/framework/widget-core/Registry';
import { widgetInstanceMap } from '@dojo/framework/widget-core/WidgetBase';
import { RegistryHandler } from '@dojo/framework/widget-core/RegistryHandler';
import { auto } from '@dojo/framework/widget-core/diff';
import {
	WNode,
	VNode,
	Constructor,
	DomVNode,
	VNodeProperties,
	TransitionStrategy,
	LazyDefine,
	SupportedClassName,
	DNode,
	RenderResult,
	WidgetBaseInterface
} from '@dojo/framework/widget-core/interfaces';

export interface BaseNodeWrapper {
	node: WNode<any> | VNode;
	domNode?: Node;
	childrenWrappers?: DNodeWrapper[];
	depth: number;
	order: number;
	requiresInsertBefore?: boolean;
	hasPreviousSiblings?: boolean;
	hasParentWNode?: boolean;
	namespace?: string;
	hasAnimations?: boolean;
}

export interface WNodeWrapper extends BaseNodeWrapper {
	id: string;
	node: WNode<any>;
	instance?: any;
	mergeNodes?: Node[];
	nodeHandlerCalled?: boolean;
	registryItem?: Constructor<any> | null;
	properties: any;
}

export interface WidgetMeta {
	dirty: boolean;
	invalidator: () => void;
	middleware: any;
	registryHandler: RegistryHandler;
	properties: any;
}

export interface VNodeWrapper extends BaseNodeWrapper {
	node: VNode | DomVNode;
	merged?: boolean;
	inserted?: boolean;
	deferredProperties?: VNodeProperties;
}

export type DNodeWrapper = VNodeWrapper | WNodeWrapper;

export interface MountOptions {
	sync: boolean;
	merge: boolean;
	transition: TransitionStrategy;
	domNode: HTMLElement;
	registry: Registry | null;
}

export interface Renderer {
	invalidate(): void;
	mount(mountOptions?: Partial<MountOptions>): void;
}

interface ProcessItem {
	current?: (WNodeWrapper | VNodeWrapper)[];
	next?: (WNodeWrapper | VNodeWrapper)[];
	meta: ProcessMeta;
}

interface ProcessResult {
	item?: ProcessItem;
	widget?: AttachApplication | DetachApplication;
	dom?: ApplicationInstruction;
}

interface ProcessMeta {
	mergeNodes?: Node[];
	oldIndex?: number;
	newIndex?: number;
}

interface InvalidationQueueItem {
	id: string;
	depth: number;
	order: number;
}

interface Instruction {
	current: undefined | DNodeWrapper;
	next: undefined | DNodeWrapper;
}

interface CreateWidgetInstruction {
	next: WNodeWrapper;
}

interface UpdateWidgetInstruction {
	current: WNodeWrapper;
	next: WNodeWrapper;
}

interface RemoveWidgetInstruction {
	current: WNodeWrapper;
}

interface CreateDomInstruction {
	next: VNodeWrapper;
}

interface UpdateDomInstruction {
	current: VNodeWrapper;
	next: VNodeWrapper;
}

interface RemoveDomInstruction {
	current: VNodeWrapper;
}

interface AttachApplication {
	type: 'attach';
	instance: any;
	attached: boolean;
}

interface DetachApplication {
	type: 'detach';
	current: WNodeWrapper;
}

interface CreateDomApplication {
	type: 'create';
	current?: VNodeWrapper;
	next: VNodeWrapper;
	parentDomNode: Node;
}

interface DeleteDomApplication {
	type: 'delete';
	current: VNodeWrapper;
}

interface UpdateDomApplication {
	type: 'update';
	current: VNodeWrapper;
	next: VNodeWrapper;
}

interface PreviousProperties {
	properties: any;
	attributes?: any;
	events?: any;
}

type ApplicationInstruction =
	| CreateDomApplication
	| UpdateDomApplication
	| DeleteDomApplication
	| AttachApplication
	| DetachApplication;

const EMPTY_ARRAY: DNodeWrapper[] = [];
const nodeOperations = ['focus', 'blur', 'scrollIntoView', 'click'];
const NAMESPACE_W3 = 'http://www.w3.org/';
const NAMESPACE_SVG = NAMESPACE_W3 + '2000/svg';
const NAMESPACE_XLINK = NAMESPACE_W3 + '1999/xlink';

function isLazyDefine(item: any): item is LazyDefine<any> {
	return Boolean(item && item.label);
}

function isWNodeWrapper(child: DNodeWrapper): child is WNodeWrapper {
	return child && isWNode(child.node);
}

function isVNodeWrapper(child?: DNodeWrapper | null): child is VNodeWrapper {
	return !!child && isVNode(child.node);
}

function isAttachApplication(value: any): value is AttachApplication | DetachApplication {
	return !!value.type;
}

function toTextVNode(data: any): VNode {
	return {
		tag: '',
		properties: {},
		children: undefined,
		text: `${data}`,
		type: VNODE
	};
}

function updateAttributes(
	domNode: Element,
	previousAttributes: { [index: string]: string | undefined },
	attributes: { [index: string]: string | undefined },
	namespace?: string
) {
	const attrNames = Object.keys(attributes);
	const attrCount = attrNames.length;
	for (let i = 0; i < attrCount; i++) {
		const attrName = attrNames[i];
		const attrValue = attributes[attrName];
		const previousAttrValue = previousAttributes[attrName];
		if (attrValue !== previousAttrValue) {
			updateAttribute(domNode, attrName, attrValue, namespace);
		}
	}
}

function diffProperties(current: any, next: any, id: string, invalidator: () => void) {
	const customDiffs = customDiffMap.get(id);
	if (customDiffs) {
		for (let i = 0; i < customDiffs.length; i++) {
			const result = customDiffs[i](current, next);
			if (result) {
				invalidator();
				return;
			}
		}
	}
	const propertyNames = [...Object.keys(current), ...Object.keys(next)];
	let diffedProperties = [];
	for (let i = 0; i < propertyNames.length; i++) {
		if (diffedProperties.indexOf(propertyNames[i]) > -1) {
			continue;
		}
		const result = auto(current[propertyNames[i]], next[propertyNames[i]]);
		if (result.changed) {
			invalidator();
			break;
		}
		diffedProperties.push(propertyNames[i]);
	}
}

function buildPreviousProperties(domNode: any, current: VNodeWrapper) {
	const {
		node: { diffType, properties, attributes }
	} = current;
	if (!diffType || diffType === 'vdom') {
		return {
			properties: current.deferredProperties
				? { ...current.deferredProperties, ...current.node.properties }
				: current.node.properties,
			attributes: current.node.attributes,
			events: current.node.events
		};
	} else if (diffType === 'none') {
		return {
			properties: {},
			attributes: current.node.attributes ? {} : undefined,
			events: current.node.events
		};
	}
	let newProperties: any = {
		properties: {}
	};
	if (attributes) {
		newProperties.attributes = {};
		newProperties.events = current.node.events;
		Object.keys(properties).forEach((propName) => {
			newProperties.properties[propName] = domNode[propName];
		});
		Object.keys(attributes).forEach((attrName) => {
			newProperties.attributes[attrName] = domNode.getAttribute(attrName);
		});
		return newProperties;
	}
	newProperties.properties = Object.keys(properties).reduce(
		(props, property) => {
			props[property] = domNode.getAttribute(property) || domNode[property];
			return props;
		},
		{} as any
	);
	return newProperties;
}

function checkDistinguishable(wrappers: DNodeWrapper[], index: number, parentWNodeWrapper?: WNodeWrapper) {
	const wrapperToCheck = wrappers[index];
	if (isVNodeWrapper(wrapperToCheck) && !wrapperToCheck.node.tag) {
		return;
	}
	const { key } = wrapperToCheck.node.properties;
	let parentName = 'unknown';
	if (parentWNodeWrapper) {
		const {
			node: { widgetConstructor }
		} = parentWNodeWrapper;
		parentName = (widgetConstructor as any).name || 'unknown';
	}

	if (key === undefined || key === null) {
		for (let i = 0; i < wrappers.length; i++) {
			if (i !== index) {
				const wrapper = wrappers[i];
				if (same(wrapper, wrapperToCheck)) {
					let nodeIdentifier: string;
					if (isWNodeWrapper(wrapper)) {
						nodeIdentifier = (wrapper.node.widgetConstructor as any).name || 'unknown';
					} else {
						nodeIdentifier = wrapper.node.tag;
					}

					console.warn(
						`A widget (${parentName}) has had a child added or removed, but they were not able to uniquely identified. It is recommended to provide a unique 'key' property when using the same widget or element (${nodeIdentifier}) multiple times as siblings`
					);
					break;
				}
			}
		}
	}
}

function same(dnode1: DNodeWrapper, dnode2: DNodeWrapper): boolean {
	if (isVNodeWrapper(dnode1) && isVNodeWrapper(dnode2)) {
		if (isDomVNode(dnode1.node) && isDomVNode(dnode2.node)) {
			if (dnode1.node.domNode !== dnode2.node.domNode) {
				return false;
			}
		}
		if (dnode1.node.tag !== dnode2.node.tag) {
			return false;
		}
		if (dnode1.node.properties.key !== dnode2.node.properties.key) {
			return false;
		}
		return true;
	} else if (isWNodeWrapper(dnode1) && isWNodeWrapper(dnode2)) {
		const widgetConstructor1 = dnode1.registryItem || dnode1.node.widgetConstructor;
		const widgetConstructor2 = dnode2.registryItem || dnode2.node.widgetConstructor;
		if (dnode1.instance === undefined && typeof widgetConstructor2 === 'string') {
			return false;
		}
		if (widgetConstructor1 !== widgetConstructor2) {
			return false;
		}
		if (dnode1.node.properties.key !== dnode2.node.properties.key) {
			return false;
		}
		return true;
	}
	return false;
}

function findIndexOfChild(children: DNodeWrapper[], sameAs: DNodeWrapper, start: number) {
	for (let i = start; i < children.length; i++) {
		if (same(children[i], sameAs)) {
			return i;
		}
	}
	return -1;
}

function createClassPropValue(classes: SupportedClassName | SupportedClassName[] = []) {
	let classNames = '';
	if (Array.isArray(classes)) {
		for (let i = 0; i < classes.length; i++) {
			let className = classes[i];
			if (className && className !== true) {
				classNames = classNames ? `${classNames} ${className}` : className;
			}
		}
		return classNames;
	}
	if (classes && classes !== true) {
		classNames = classes;
	}
	return classNames;
}

function updateAttribute(domNode: Element, attrName: string, attrValue: string | undefined, namespace?: string) {
	if (namespace === NAMESPACE_SVG && attrName === 'href' && attrValue) {
		domNode.setAttributeNS(NAMESPACE_XLINK, attrName, attrValue);
	} else if ((attrName === 'role' && attrValue === '') || attrValue === undefined) {
		domNode.removeAttribute(attrName);
	} else {
		domNode.setAttribute(attrName, attrValue);
	}
}

function runEnterAnimation(next: VNodeWrapper, transitions: TransitionStrategy) {
	const {
		domNode,
		node: { properties },
		node: {
			properties: { enterAnimation }
		}
	} = next;
	if (enterAnimation && enterAnimation !== true) {
		if (typeof enterAnimation === 'function') {
			return enterAnimation(domNode as Element, properties);
		}
		transitions.enter(domNode as Element, properties, enterAnimation);
	}
}

function runExitAnimation(current: VNodeWrapper, transitions: TransitionStrategy, exitAnimation: string | Function) {
	const {
		domNode,
		node: { properties }
	} = current;
	const removeDomNode = () => {
		domNode && domNode.parentNode && domNode.parentNode.removeChild(domNode);
		current.domNode = undefined;
	};
	if (typeof exitAnimation === 'function') {
		return exitAnimation(domNode as Element, removeDomNode, properties);
	}
	transitions.exit(domNode as Element, properties, exitAnimation, removeDomNode);
}

function arrayFrom(arr: any) {
	return Array.prototype.slice.call(arr);
}

function wrapNodes(renderer: () => any) {
	const result = renderer();
	const isWNodeWrapper = isWNode(result);
	const App = widget()(() => {
		return result;
	});
	(App as any).isWNodeWrapper = isWNodeWrapper;
	return App;
}

const widgetMetaMap = new Map<string, WidgetMeta>();
const registeredNodes = new Set();
const customDiffMap = new Map<string, Function[]>();
let wrapperId = 0;

export function registerCustomDiff(id: string, diff: Function) {
	const [widgetId] = id.split('-');
	const diffs = customDiffMap.get(widgetId) || [];
	diffs.push(diff);
	customDiffMap.set(widgetId, diffs);
}

const domNodeCacheMap = new Map<string, Map<string | number, HTMLElement>>();

export function getRegistry(id: string): RegistryHandler | null {
	const [widgetId] = id.split('-');
	const widgetMeta = widgetMetaMap.get(widgetId);
	if (widgetMeta) {
		return widgetMeta.registryHandler;
	}
	return null;
}

function addNodeToMap(id: string, key: string | number, node: HTMLElement) {
	const nodeMap = domNodeCacheMap.get(id) || new Map();
	const widgetMeta = widgetMetaMap.get(id);
	const existingNode = nodeMap.get(key);
	if (widgetMeta && !existingNode) {
		nodeMap.set(key, node);
		if (registeredNodes.has(`${id}-${key}`)) {
			widgetMeta.invalidator();
			registeredNodes.delete(`${id}-${key}`);
		}
	}
	domNodeCacheMap.set(id, nodeMap);
}

export function getNodeById(id: string, key: string | number) {
	const [widgetId] = id.split('-');
	const nodeMap = domNodeCacheMap.get(widgetId);
	if (!nodeMap) {
		registeredNodes.add(`${widgetId}-${key}`);
		return null;
	}
	const foundNode = nodeMap.get(key) || null;
	return foundNode;
}

export function renderer(renderer: () => any): Renderer {
	let _mountOptions: MountOptions = {
		sync: false,
		merge: true,
		transition: transitionStrategy,
		domNode: global.document.body,
		registry: null
	};
	let _invalidationQueue: InvalidationQueueItem[] = [];
	let _processQueue: (ProcessItem | DetachApplication | AttachApplication)[] = [];
	let _deferredProcessQueue: (ProcessItem | DetachApplication | AttachApplication)[] = [];
	let _applicationQueue: ApplicationInstruction[] = [];
	let _eventMap = new WeakMap<Function, EventListener>();
	let _idToWrapperMap = new Map<string, WNodeWrapper>();
	let _parentWrapperMap = new WeakMap<DNodeWrapper, DNodeWrapper>();
	let _wrapperSiblingMap = new WeakMap<DNodeWrapper, DNodeWrapper>();
	let _insertBeforeMap: undefined | WeakMap<DNodeWrapper, Node> = new WeakMap<DNodeWrapper, Node>();
	let _nodeToInstanceMap = new WeakMap<VNode | WNode<any>, WNodeWrapper>();
	let _renderScheduled: number | undefined;
	let _idleCallbacks: Function[] = [];
	let _deferredRenderCallbacks: Function[] = [];
	let parentInvalidate: () => void;
	let _allMergedNodes: Node[] = [];

	function nodeOperation(
		propName: string,
		propValue: (() => boolean) | boolean,
		previousValue: boolean,
		domNode: HTMLElement & { [index: string]: any }
	): void {
		let result = propValue && !previousValue;
		if (typeof propValue === 'function') {
			result = propValue();
		}
		if (result === true) {
			_deferredRenderCallbacks.push(() => {
				domNode[propName]();
			});
		}
	}

	function updateEvent(
		domNode: Node,
		eventName: string,
		currentValue: (event: Event) => void,
		previousValue?: Function
	) {
		if (previousValue) {
			const previousEvent = _eventMap.get(previousValue);
			previousEvent && domNode.removeEventListener(eventName, previousEvent);
		}

		let callback = currentValue;

		if (eventName === 'input') {
			callback = function(this: any, evt: Event) {
				currentValue.call(this, evt);
				(evt.target as any)['oninput-value'] = (evt.target as HTMLInputElement).value;
			};
		}

		domNode.addEventListener(eventName, callback);
		_eventMap.set(currentValue, callback);
	}

	function removeOrphanedEvents(
		domNode: Element,
		previousProperties: VNodeProperties,
		properties: VNodeProperties,
		onlyEvents: boolean = false
	) {
		Object.keys(previousProperties).forEach((propName) => {
			const isEvent = propName.substr(0, 2) === 'on' || onlyEvents;
			const eventName = onlyEvents ? propName : propName.substr(2);
			if (isEvent && !properties[propName]) {
				const eventCallback = _eventMap.get(previousProperties[propName]);
				if (eventCallback) {
					domNode.removeEventListener(eventName, eventCallback);
				}
			}
		});
	}

	function resolveRegistryItem(wrapper: WNodeWrapper, instance?: any, id?: string) {
		const owningNode = _nodeToInstanceMap.get(wrapper.node);
		if (owningNode) {
			if (owningNode.instance) {
				instance = owningNode.instance;
			} else {
				id = owningNode.id;
			}
		}
		let registry: RegistryHandler | undefined;
		if (instance) {
			const instanceData = widgetInstanceMap.get(instance);
			if (instanceData) {
				registry = instanceData.registry;
			}
		} else if (id !== undefined) {
			const widgetMeta = widgetMetaMap.get(id);
			if (widgetMeta) {
				registry = widgetMeta.registryHandler;
			}
		}

		if (registry) {
			if (!isWidget(wrapper.node.widgetConstructor)) {
				let registryLabel: symbol | string;
				if (isLazyDefine(wrapper.node.widgetConstructor)) {
					const { label, registryItem } = wrapper.node.widgetConstructor;
					if (!registry.has(label)) {
						registry.define(label, registryItem);
					}
					registryLabel = label;
				} else {
					registryLabel = wrapper.node.widgetConstructor as any;
				}

				wrapper.registryItem = registry.get(registryLabel);
			}
		}
	}

	function mapNodeToInstance(nodes: DNode[], wrapper: WNodeWrapper) {
		let node: DNode;
		while ((node = nodes.pop())) {
			if (isWNode(node) || isVNode(node)) {
				if (!_nodeToInstanceMap.has(node)) {
					_nodeToInstanceMap.set(node, wrapper);
					if (node.children && node.children.length) {
						nodes = [...nodes, ...node.children];
					}
				}
			}
		}
	}

	function renderedToWrapper(
		rendered: DNode[],
		parent: DNodeWrapper,
		currentParent: DNodeWrapper | null
	): DNodeWrapper[] {
		const { requiresInsertBefore, hasPreviousSiblings, namespace, depth } = parent;
		const wrappedRendered: DNodeWrapper[] = [];
		const hasParentWNode = isWNodeWrapper(parent);
		const currentParentChildren = (isVNodeWrapper(currentParent) && currentParent.childrenWrappers) || [];
		const hasCurrentParentChildren = currentParentChildren.length > 0;
		const insertBefore =
			((requiresInsertBefore || hasPreviousSiblings !== false) && hasParentWNode) ||
			(hasCurrentParentChildren && rendered.length > 1);
		let previousItem: DNodeWrapper | undefined;
		if (isWNodeWrapper(parent) && rendered.length) {
			mapNodeToInstance([...rendered], parent);
		}
		for (let i = 0; i < rendered.length; i++) {
			let renderedItem = rendered[i];
			if (!renderedItem || renderedItem === true) {
				continue;
			}
			if (typeof renderedItem === 'string') {
				renderedItem = toTextVNode(renderedItem);
			}
			const wrapper: DNodeWrapper = {
				node: renderedItem,
				depth: depth + 1,
				order: i,
				requiresInsertBefore: insertBefore,
				hasParentWNode,
				namespace: namespace
			} as DNodeWrapper;
			if (isVNode(renderedItem)) {
				if (renderedItem.deferredPropertiesCallback) {
					(wrapper as VNodeWrapper).deferredProperties = renderedItem.deferredPropertiesCallback(false);
				}
				if (renderedItem.properties.exitAnimation) {
					parent.hasAnimations = true;
					let nextParent = _parentWrapperMap.get(parent);
					while (nextParent) {
						if (nextParent.hasAnimations) {
							break;
						}
						nextParent.hasAnimations = true;
						nextParent = _parentWrapperMap.get(nextParent);
					}
				}
			}
			if (isWNode(renderedItem)) {
				resolveRegistryItem(wrapper as WNodeWrapper, (parent as any).instance, (parent as any).id);
			}

			_parentWrapperMap.set(wrapper, parent);
			if (previousItem) {
				_wrapperSiblingMap.set(previousItem, wrapper);
			}
			wrappedRendered.push(wrapper);
			previousItem = wrapper;
		}
		return wrappedRendered;
	}

	function findParentWNodeWrapper(currentNode: DNodeWrapper): WNodeWrapper | undefined {
		let parentWNodeWrapper: WNodeWrapper | undefined;
		let parentWrapper = _parentWrapperMap.get(currentNode);

		while (!parentWNodeWrapper && parentWrapper) {
			if (!parentWNodeWrapper && isWNodeWrapper(parentWrapper)) {
				parentWNodeWrapper = parentWrapper;
			}
			parentWrapper = _parentWrapperMap.get(parentWrapper);
		}
		return parentWNodeWrapper;
	}

	function findParentDomNode(currentNode: DNodeWrapper): Node | undefined {
		let parentDomNode: Node | undefined;
		let parentWrapper = _parentWrapperMap.get(currentNode);

		while (!parentDomNode && parentWrapper) {
			if (!parentDomNode && isVNodeWrapper(parentWrapper) && parentWrapper.domNode) {
				parentDomNode = parentWrapper.domNode;
			}
			parentWrapper = _parentWrapperMap.get(parentWrapper);
		}
		return parentDomNode;
	}

	function runDeferredProperties(next: VNodeWrapper) {
		const { deferredPropertiesCallback } = next.node;
		if (deferredPropertiesCallback) {
			const properties = next.node.properties;
			_deferredRenderCallbacks.push(() => {
				const deferredProperties = next.deferredProperties;
				next.deferredProperties = deferredPropertiesCallback(true);
				processProperties(next, {
					properties: { ...deferredProperties, ...properties }
				});
			});
		}
	}

	function findInsertBefore(next: DNodeWrapper) {
		let insertBefore: Node | null = null;
		let searchNode: DNodeWrapper | undefined = next;
		while (!insertBefore) {
			const nextSibling = _wrapperSiblingMap.get(searchNode);
			if (nextSibling) {
				if (isVNodeWrapper(nextSibling)) {
					if (nextSibling.domNode && nextSibling.domNode.parentNode) {
						insertBefore = nextSibling.domNode;
						break;
					}
					searchNode = nextSibling;
					continue;
				}
				if (nextSibling.domNode && nextSibling.domNode.parentNode) {
					insertBefore = nextSibling.domNode;
					break;
				}
				searchNode = nextSibling;
				continue;
			}
			searchNode = _parentWrapperMap.get(searchNode);

			if (!searchNode || isVNodeWrapper(searchNode)) {
				break;
			}
		}
		return insertBefore;
	}

	function setValue(domNode: any, propValue?: any, previousValue?: any) {
		const domValue = domNode.value;
		const onInputValue = domNode['oninput-value'];
		const onSelectValue = domNode['select-value'];

		if (onSelectValue && domValue !== onSelectValue) {
			domNode.value = onSelectValue;
			if (domNode.value === onSelectValue) {
				domNode['select-value'] = undefined;
			}
		} else if ((onInputValue && domValue === onInputValue) || propValue !== previousValue) {
			domNode.value = propValue;
			domNode['oninput-value'] = undefined;
		}
	}

	function setProperties(
		domNode: HTMLElement,
		currentProperties: VNodeProperties = {},
		nextWrapper: VNodeWrapper,
		includesEventsAndAttributes = true
	): void {
		const properties = nextWrapper.deferredProperties
			? { ...nextWrapper.deferredProperties, ...nextWrapper.node.properties }
			: nextWrapper.node.properties;
		const propNames = Object.keys(properties);
		const propCount = propNames.length;
		if (propNames.indexOf('classes') === -1 && currentProperties.classes) {
			domNode.removeAttribute('class');
		}

		includesEventsAndAttributes && removeOrphanedEvents(domNode, currentProperties, properties);

		for (let i = 0; i < propCount; i++) {
			const propName = propNames[i];
			let propValue = properties[propName];
			const previousValue = currentProperties[propName];
			if (propName === 'classes') {
				const previousClassString = createClassPropValue(previousValue);
				let currentClassString = createClassPropValue(propValue);
				if (previousClassString !== currentClassString) {
					if (currentClassString) {
						if (nextWrapper.merged) {
							const domClasses = (domNode.getAttribute('class') || '').split(' ');
							for (let i = 0; i < domClasses.length; i++) {
								if (currentClassString.indexOf(domClasses[i]) === -1) {
									currentClassString = `${domClasses[i]} ${currentClassString}`;
								}
							}
						}
						domNode.setAttribute('class', currentClassString);
					} else {
						domNode.removeAttribute('class');
					}
				}
			} else if (nodeOperations.indexOf(propName) !== -1) {
				nodeOperation(propName, propValue, previousValue, domNode);
			} else if (propName === 'styles') {
				const styleNames = Object.keys(propValue);
				const styleCount = styleNames.length;
				for (let j = 0; j < styleCount; j++) {
					const styleName = styleNames[j];
					const newStyleValue = propValue[styleName];
					const oldStyleValue = previousValue && previousValue[styleName];
					if (newStyleValue === oldStyleValue) {
						continue;
					}
					(domNode.style as any)[styleName] = newStyleValue || '';
				}
			} else {
				if (!propValue && typeof previousValue === 'string') {
					propValue = '';
				}
				if (propName === 'value') {
					if ((domNode as HTMLElement).tagName === 'SELECT') {
						(domNode as any)['select-value'] = propValue;
					}
					setValue(domNode, propValue, previousValue);
				} else if (propName !== 'key' && propValue !== previousValue) {
					const type = typeof propValue;
					if (type === 'function' && propName.lastIndexOf('on', 0) === 0 && includesEventsAndAttributes) {
						updateEvent(domNode, propName.substr(2), propValue, previousValue);
					} else if (type === 'string' && propName !== 'innerHTML' && includesEventsAndAttributes) {
						updateAttribute(domNode, propName, propValue, nextWrapper.namespace);
					} else if (propName === 'scrollLeft' || propName === 'scrollTop') {
						if ((domNode as any)[propName] !== propValue) {
							(domNode as any)[propName] = propValue;
						}
					} else {
						(domNode as any)[propName] = propValue;
					}
				}
			}
		}
	}

	function runDeferredRenderCallbacks() {
		const { sync } = _mountOptions;
		const callbacks = _deferredRenderCallbacks;
		_deferredRenderCallbacks = [];
		if (callbacks.length) {
			const run = () => {
				let callback: Function | undefined;
				while ((callback = callbacks.shift())) {
					callback();
				}
			};
			if (sync) {
				run();
			} else {
				global.requestAnimationFrame(run);
			}
		}
	}

	function runAfterRenderCallbacks() {
		const { sync } = _mountOptions;
		const callbacks = _idleCallbacks;
		_idleCallbacks = [];
		if (callbacks.length) {
			const run = () => {
				let callback: Function | undefined;
				while ((callback = callbacks.shift())) {
					callback();
				}
			};
			if (sync) {
				run();
			} else {
				if (global.requestIdleCallback) {
					global.requestIdleCallback(run);
				} else {
					setTimeout(run);
				}
			}
		}
	}

	function processProperties(next: VNodeWrapper, previousProperties: PreviousProperties) {
		if (next.node.attributes && next.node.events) {
			updateAttributes(
				next.domNode as HTMLElement,
				previousProperties.attributes || {},
				next.node.attributes,
				next.namespace
			);
			setProperties(next.domNode as HTMLElement, previousProperties.properties, next, false);
			const events = next.node.events || {};
			if (previousProperties.events) {
				removeOrphanedEvents(
					next.domNode as HTMLElement,
					previousProperties.events || {},
					next.node.events,
					true
				);
			}
			previousProperties.events = previousProperties.events || {};
			Object.keys(events).forEach((event) => {
				updateEvent(next.domNode as HTMLElement, event, events[event], previousProperties.events[event]);
			});
		} else {
			setProperties(next.domNode as HTMLElement, previousProperties.properties, next);
		}
	}

	function mount(mountOptions: Partial<MountOptions> = {}) {
		_mountOptions = { ..._mountOptions, ...mountOptions };
		const { domNode } = _mountOptions;
		const renderResult = w(wrapNodes(renderer), {});
		const nextWrapper = {
			id: `${wrapperId++}`,
			node: renderResult,
			order: 0,
			depth: 1,
			properties: {}
		};
		_parentWrapperMap.set(nextWrapper, {
			id: `${wrapperId++}`,
			depth: 0,
			order: 0,
			domNode,
			node: v('fake')
		});
		_processQueue.push({
			current: [],
			next: [nextWrapper],
			meta: { mergeNodes: arrayFrom(domNode.childNodes) }
		});
		_runProcessQueue();
		_cleanUpMergedNodes();
		_runDomInstructionQueue();
		_insertBeforeMap = undefined;
		_runCallbacks();
	}

	function invalidate() {
		parentInvalidate && parentInvalidate();
	}

	function _schedule(): void {
		const { sync } = _mountOptions;
		if (sync) {
			_runInvalidationQueue();
		} else if (!_renderScheduled) {
			_renderScheduled = global.requestAnimationFrame(() => {
				_runInvalidationQueue();
			});
		}
	}

	function _runInvalidationQueue() {
		_renderScheduled = undefined;
		const invalidationQueue = [..._invalidationQueue];
		const previouslyRendered = [];
		_invalidationQueue = [];
		invalidationQueue.sort((a, b) => {
			let result = b.depth - a.depth;
			if (result === 0) {
				result = b.order - a.order;
			}
			return result;
		});
		let item: InvalidationQueueItem | undefined;
		while ((item = invalidationQueue.pop())) {
			let { id } = item;
			if (previouslyRendered.indexOf(id) === -1 && _idToWrapperMap.has(id!)) {
				previouslyRendered.push(id);
				const current = _idToWrapperMap.get(id)!;
				const parent = _parentWrapperMap.get(current);
				const sibling = _wrapperSiblingMap.get(current);
				const next = {
					node: {
						type: WNODE,
						widgetConstructor: current.node.widgetConstructor,
						properties: current.properties || {},
						children: current.node.children || []
					},
					instance: current.instance,
					id: current.id,
					properties: current.properties,
					depth: current.depth,
					order: current.order,
					registryItem: current.registryItem
				};

				parent && _parentWrapperMap.set(next, parent);
				sibling && _wrapperSiblingMap.set(next, sibling);
				const { item } = _updateWidget({ current, next });
				if (item) {
					_processQueue.push(item);
					if (_deferredProcessQueue.length) {
						_processQueue = [..._processQueue, ..._deferredProcessQueue];
						_deferredProcessQueue = [];
					}
					_idToWrapperMap.set(id, next);
					_runProcessQueue();
				}
			}
		}
		_cleanUpMergedNodes();
		_runDomInstructionQueue();
		_runCallbacks();
	}

	function _cleanUpMergedNodes() {
		if (_deferredProcessQueue.length === 0) {
			let mergedNode: Node | undefined;
			while ((mergedNode = _allMergedNodes.pop())) {
				mergedNode.parentNode && mergedNode.parentNode.removeChild(mergedNode);
			}
			_mountOptions.merge = false;
		}
	}

	function _runProcessQueue() {
		let item: DetachApplication | AttachApplication | ProcessItem | undefined;
		while ((item = _processQueue.pop())) {
			if (isAttachApplication(item)) {
				_applicationQueue.push(item);
			} else {
				const { current, next, meta } = item;
				_process(current || EMPTY_ARRAY, next || EMPTY_ARRAY, meta);
			}
		}
	}

	function _runDomInstructionQueue(): void {
		_applicationQueue.reverse();
		let item: ApplicationInstruction | undefined;
		while ((item = _applicationQueue.pop())) {
			if (item.type === 'create') {
				const {
					parentDomNode,
					next,
					next: { domNode, merged, requiresInsertBefore, node }
				} = item;

				processProperties(next, { properties: {} });
				runDeferredProperties(next);
				if (!merged) {
					let insertBefore: any;
					if (requiresInsertBefore) {
						insertBefore = findInsertBefore(next);
					} else if (_insertBeforeMap) {
						insertBefore = _insertBeforeMap.get(next);
					}
					parentDomNode.insertBefore(domNode!, insertBefore);
					if (isDomVNode(next.node) && next.node.onAttach) {
						next.node.onAttach();
					}
				}
				if ((domNode as HTMLElement).tagName === 'OPTION' && domNode!.parentElement) {
					setValue(domNode!.parentElement);
				}
				runEnterAnimation(next, _mountOptions.transition);
				const owningWrapper = _nodeToInstanceMap.get(next.node);
				if (owningWrapper && node.properties.key != null) {
					if (owningWrapper.instance) {
						const instanceData = widgetInstanceMap.get(owningWrapper.instance);
						instanceData && instanceData.nodeHandler.add(domNode as HTMLElement, `${node.properties.key}`);
					} else {
						addNodeToMap(owningWrapper.id, node.properties.key, domNode as HTMLElement);
					}
				}
				item.next.inserted = true;
			} else if (item.type === 'update') {
				const {
					next,
					next: { domNode },
					current
				} = item;
				const parent = _parentWrapperMap.get(next);
				if (parent && isWNodeWrapper(parent) && parent.instance) {
					const instanceData = widgetInstanceMap.get(parent.instance);
					instanceData && instanceData.nodeHandler.addRoot();
				}

				const previousProperties = buildPreviousProperties(domNode, current);
				processProperties(next, previousProperties);
				runDeferredProperties(next);

				const owningWrapper = _nodeToInstanceMap.get(next.node);
				if (owningWrapper && owningWrapper.instance) {
					const instanceData = widgetInstanceMap.get(owningWrapper.instance);
					if (instanceData && next.node.properties.key != null) {
						instanceData.nodeHandler.add(next.domNode as HTMLElement, `${next.node.properties.key}`);
					}
				}
			} else if (item.type === 'delete') {
				const { current } = item;
				const { exitAnimation } = current.node.properties;
				if (exitAnimation && exitAnimation !== true) {
					runExitAnimation(current, _mountOptions.transition, exitAnimation);
				} else {
					current.domNode!.parentNode!.removeChild(current.domNode!);
					current.domNode = undefined;
				}
			} else if (item.type === 'attach') {
				const { instance, attached } = item;
				const instanceData = widgetInstanceMap.get(instance);
				instanceData && instanceData.nodeHandler.addRoot();
				attached && instanceData && instanceData.onAttach();
			} else if (item.type === 'detach') {
				if (item.current.instance) {
					const instanceData = widgetInstanceMap.get(item.current.instance);
					instanceData && instanceData.onDetach();
				}
				item.current.domNode = undefined;
				item.current.instance = undefined;
			}
		}
		if (_deferredProcessQueue.length === 0) {
			_nodeToInstanceMap = new WeakMap();
		}
	}

	function _runCallbacks() {
		runAfterRenderCallbacks();
		runDeferredRenderCallbacks();
	}

	function _processMergeNodes(next: DNodeWrapper, mergeNodes: Node[]) {
		const { merge } = _mountOptions;
		if (merge && mergeNodes.length) {
			if (isVNodeWrapper(next)) {
				let {
					node: { tag }
				} = next;
				for (let i = 0; i < mergeNodes.length; i++) {
					const domElement = mergeNodes[i] as Element;
					if (tag.toUpperCase() === (domElement.tagName || '')) {
						const mergeNodeIndex = _allMergedNodes.indexOf(domElement);
						if (mergeNodeIndex !== -1) {
							_allMergedNodes.splice(mergeNodeIndex, 1);
						}
						mergeNodes.splice(i, 1);
						next.domNode = domElement;
						break;
					}
				}
			} else {
				next.mergeNodes = mergeNodes;
			}
		}
	}

	function registerDistinguishableCallback(childNodes: DNodeWrapper[], index: number) {
		_idleCallbacks.push(() => {
			const parentWNodeWrapper = findParentWNodeWrapper(childNodes[index]);
			checkDistinguishable(childNodes, index, parentWNodeWrapper);
		});
	}

	function _process(current: DNodeWrapper[], next: DNodeWrapper[], meta: ProcessMeta = {}): void {
		let { mergeNodes = [], oldIndex = 0, newIndex = 0 } = meta;
		const currentLength = current.length;
		const nextLength = next.length;
		const hasPreviousSiblings = currentLength > 1 || (currentLength > 0 && currentLength < nextLength);
		const instructions: Instruction[] = [];
		if (newIndex < nextLength) {
			let currentWrapper = oldIndex < currentLength ? current[oldIndex] : undefined;
			const nextWrapper = next[newIndex];
			nextWrapper.hasPreviousSiblings = hasPreviousSiblings;

			_processMergeNodes(nextWrapper, mergeNodes);

			if (currentWrapper && same(currentWrapper, nextWrapper)) {
				oldIndex++;
				newIndex++;
				if (isVNodeWrapper(currentWrapper) && isVNodeWrapper(nextWrapper)) {
					nextWrapper.inserted = currentWrapper.inserted;
				}
				instructions.push({ current: currentWrapper, next: nextWrapper });
			} else if (!currentWrapper || findIndexOfChild(current, nextWrapper, oldIndex + 1) === -1) {
				has('dojo-debug') && current.length && registerDistinguishableCallback(next, newIndex);
				instructions.push({ current: undefined, next: nextWrapper });
				newIndex++;
			} else if (findIndexOfChild(next, currentWrapper, newIndex + 1) === -1) {
				has('dojo-debug') && registerDistinguishableCallback(current, oldIndex);
				instructions.push({ current: currentWrapper, next: undefined });
				oldIndex++;
			} else {
				has('dojo-debug') && registerDistinguishableCallback(next, newIndex);
				has('dojo-debug') && registerDistinguishableCallback(current, oldIndex);
				instructions.push({ current: currentWrapper, next: undefined });
				instructions.push({ current: undefined, next: nextWrapper });
				oldIndex++;
				newIndex++;
			}
		}

		if (newIndex < nextLength) {
			_processQueue.push({
				current,
				next,
				meta: { mergeNodes, oldIndex, newIndex }
			});
		}

		if (currentLength > oldIndex && newIndex >= nextLength) {
			for (let i = oldIndex; i < currentLength; i++) {
				has('dojo-debug') && registerDistinguishableCallback(current, i);
				instructions.push({ current: current[i], next: undefined });
			}
		}

		for (let i = 0; i < instructions.length; i++) {
			const result = _processOne(instructions[i]);
			if (result === false) {
				if (_mountOptions.merge && mergeNodes.length) {
					if (newIndex < nextLength) {
						_processQueue.pop();
					}
					_processQueue.push({ next, current, meta });
					_deferredProcessQueue = _processQueue;
					_processQueue = [];
					break;
				}
				continue;
			}
			const { widget, item, dom } = result;
			widget && _processQueue.push(widget);
			item && _processQueue.push(item);
			dom && _applicationQueue.push(dom);
		}
	}

	function _processOne({ current, next }: Instruction): ProcessResult | false {
		if (current !== next) {
			if (!current && next) {
				if (isVNodeWrapper(next)) {
					return _createDom({ next });
				} else {
					return _createWidget({ next });
				}
			} else if (current && next) {
				if (isVNodeWrapper(current) && isVNodeWrapper(next)) {
					return _updateDom({ current, next });
				} else if (isWNodeWrapper(current) && isWNodeWrapper(next)) {
					return _updateWidget({ current, next });
				}
			} else if (current && !next) {
				if (isVNodeWrapper(current)) {
					return _removeDom({ current });
				} else if (isWNodeWrapper(current)) {
					return _removeWidget({ current });
				}
			}
		}
		return {};
	}

	let metaId = 0;

	function resolveMiddleware(middlewares: any, id: string): any {
		const keys = Object.keys(middlewares);
		const results: any = {};
		const uniqueId = `${id}-${metaId++}`;
		for (let i = 0; i < keys.length; i++) {
			const middleware = middlewares[keys[i]];
			const widgetMeta = widgetMetaMap.get(id)!;
			const payload: any = {
				id: uniqueId,
				invalidator: widgetMeta.invalidator
			};
			Object.defineProperty(payload, 'properties', {
				get() {
					const widgetMeta = widgetMetaMap.get(id);
					if (widgetMeta) {
						return { ...widgetMeta.properties };
					}
				},
				enumerable: true,
				configurable: true
			});
			if (middleware.middlewares) {
				const blah = resolveMiddleware(middleware.middlewares, id);
				payload.middleware = blah;
				results[keys[i]] = middleware.callback(payload);
			} else {
				results[keys[i]] = middleware.callback(payload);
			}
		}
		return results;
	}

	function _createWidget({ next }: CreateWidgetInstruction): ProcessResult | false {
		let {
			node: { widgetConstructor }
		} = next;
		let { registry } = _mountOptions;
		let Constructor = next.registryItem || widgetConstructor;
		if (!isWidget(Constructor)) {
			resolveRegistryItem(next);
			if (!next.registryItem) {
				return false;
			}
			Constructor = next.registryItem;
		}

		let rendered: RenderResult;
		let instance: any;
		let invalidate: () => void;
		next.properties = next.node.properties;
		next.id = `${wrapperId++}`;
		if (!isWidgetBaseConstructor(Constructor)) {
			invalidate = () => {
				const widgetMeta = widgetMetaMap.get(next.id);
				if (widgetMeta) {
					widgetMeta.dirty = true;
				}
				_invalidationQueue.push({
					id: next.id,
					depth: next.depth,
					order: next.order
				});
				_schedule();
			};
			const registryHandler = new RegistryHandler();
			registryHandler.on('invalidate', invalidate);
			if (registry) {
				registryHandler.base = registry;
			}

			const widgetMeta = {
				dirty: false,
				invalidator: invalidate,
				middleware: undefined,
				registryHandler,
				properties: next.node.properties
			};
			widgetMetaMap.set(next.id, widgetMeta);

			let middleware = (Constructor as any).middlewares;

			if (middleware) {
				middleware = resolveMiddleware(middleware, next.id);
				widgetMeta.middleware = middleware;
			}

			rendered = (Constructor as any)({
				properties: next.node.properties,
				children: next.node.children,
				middleware
			});
		} else {
			instance = new Constructor() as WidgetBaseInterface & {
				invalidate: any;
				registry: any;
			};
			if (registry) {
				instance.registry.base = registry;
			}
			const instanceData = widgetInstanceMap.get(instance)!;
			invalidate = () => {
				instanceData.dirty = true;
				if (!instanceData.rendering && _idToWrapperMap.has(next.id)) {
					_invalidationQueue.push({
						id: next.id,
						depth: next.depth,
						order: next.order
					});
					_schedule();
				}
			};
			instanceData.invalidate = invalidate;
			instanceData.rendering = true;
			instance.__setProperties__(next.node.properties);
			instance.__setChildren__(next.node.children);
			next.instance = instance;
			rendered = instance.__render__();
			instanceData.rendering = false;
		}
		if (rendered) {
			rendered = Array.isArray(rendered) ? rendered : [rendered];
			next.childrenWrappers = renderedToWrapper(rendered, next, null);
		}
		_idToWrapperMap.set(next.id, next);
		if (!parentInvalidate && !(next.node.widgetConstructor as any).isWNodeWrapper) {
			parentInvalidate = invalidate;
		}
		if (instance) {
			return {
				item: {
					next: next.childrenWrappers,
					meta: { mergeNodes: next.mergeNodes }
				},
				widget: { type: 'attach', instance, attached: true }
			};
		}

		return {
			item: {
				next: next.childrenWrappers,
				meta: { mergeNodes: next.mergeNodes }
			}
		};
	}

	function _updateWidget({ current, next }: UpdateWidgetInstruction): ProcessResult {
		current = _idToWrapperMap.get(current.id) || current;
		const { instance, domNode, hasAnimations } = current;
		let {
			node: { widgetConstructor }
		} = next;
		const Constructor = next.registryItem || widgetConstructor;

		if (!isWidget(Constructor)) {
			return {};
		}
		let rendered: RenderResult;
		next.hasAnimations = hasAnimations;
		next.id = current.id;
		next.properties = next.node.properties;
		if (domNode && domNode.parentNode) {
			next.domNode = domNode;
		}

		if (!isWidgetBaseConstructor(Constructor)) {
			const widgetMeta = widgetMetaMap.get(next.id);
			if (widgetMeta) {
				widgetMeta.properties = next.properties;
				diffProperties(current.properties, next.properties, `${next.id}`, () => {
					widgetMeta.dirty = true;
				});
				if (widgetMeta.dirty) {
					widgetMeta.dirty = false;
					rendered = (Constructor as any)({
						properties: next.node.properties,
						children: next.node.children,
						middleware: widgetMeta.middleware
					});
				} else {
					next.childrenWrappers = current.childrenWrappers;
					return {};
				}
			} else {
				next.childrenWrappers = current.childrenWrappers;
				return {};
			}
		} else {
			const instanceData = widgetInstanceMap.get(instance!)!;
			next.instance = instance;
			instanceData.rendering = true;
			instance!.__setProperties__(next.node.properties);
			instance!.__setChildren__(next.node.children);
			if (instanceData.dirty) {
				rendered = instance!.__render__();
			} else {
				next.childrenWrappers = current.childrenWrappers;
				if (instance) {
					return {
						widget: { type: 'attach', instance, attached: false }
					};
				}
			}
			instanceData.rendering = false;
		}
		_idToWrapperMap.set(next.id, next);

		if (rendered) {
			rendered = Array.isArray(rendered) ? rendered : [rendered];
			next.childrenWrappers = renderedToWrapper(rendered, next, current);
		}

		if (instance) {
			return {
				item: {
					current: current.childrenWrappers,
					next: next.childrenWrappers,
					meta: {}
				},
				widget: { type: 'attach', instance, attached: false }
			};
		}
		return {
			item: {
				current: current.childrenWrappers,
				next: next.childrenWrappers,
				meta: {}
			}
		};
	}

	function _removeWidget({ current }: RemoveWidgetInstruction): ProcessResult {
		current = _idToWrapperMap.get(current.id) || current;
		_wrapperSiblingMap.delete(current);
		_parentWrapperMap.delete(current);
		_idToWrapperMap.delete(current.id);
		const meta = widgetMetaMap.get(current.id);
		if (meta) {
			meta.registryHandler.destroy();
			meta.invalidator = undefined as any;
			widgetMetaMap.delete(current.id);
		}

		return {
			item: { current: current.childrenWrappers, meta: {} },
			widget: { type: 'detach', current }
		};
	}

	function setDomNodeOnParentWrapper(next: VNodeWrapper) {
		let parentWNodeWrapper = findParentWNodeWrapper(next);
		while (parentWNodeWrapper && !parentWNodeWrapper.domNode) {
			parentWNodeWrapper.domNode = next.domNode;
			const nextParent = _parentWrapperMap.get(parentWNodeWrapper);
			if (nextParent && isWNodeWrapper(nextParent)) {
				parentWNodeWrapper = nextParent;
				continue;
			}
			parentWNodeWrapper = undefined;
		}
	}

	function _createDom({ next }: CreateDomInstruction): ProcessResult {
		let mergeNodes: Node[] = [];
		const parentDomNode = findParentDomNode(next)!;
		if (!next.domNode) {
			if ((next.node as any).domNode) {
				next.domNode = (next.node as any).domNode;
			} else {
				if (next.node.tag === 'svg') {
					next.namespace = NAMESPACE_SVG;
				}
				if (next.node.tag) {
					if (next.namespace) {
						next.domNode = global.document.createElementNS(next.namespace, next.node.tag);
					} else {
						next.domNode = global.document.createElement(next.node.tag);
					}
				} else if (next.node.text != null) {
					next.domNode = global.document.createTextNode(next.node.text);
				}
			}
			if (_insertBeforeMap && _allMergedNodes.length) {
				if (parentDomNode === _allMergedNodes[0].parentNode) {
					_insertBeforeMap.set(next, _allMergedNodes[0]);
				}
			}
		} else {
			if (_mountOptions.merge) {
				mergeNodes = arrayFrom(next.domNode.childNodes);
				_allMergedNodes = [..._allMergedNodes, ...mergeNodes];
			}
			next.merged = true;
		}
		if (next.domNode) {
			if (next.node.children) {
				next.childrenWrappers = renderedToWrapper(next.node.children, next, null);
			}
		}
		setDomNodeOnParentWrapper(next);
		const dom: ApplicationInstruction = {
			next: next!,
			parentDomNode: parentDomNode,
			type: 'create'
		};
		if (next.childrenWrappers) {
			return {
				item: {
					current: [],
					next: next.childrenWrappers,
					meta: { mergeNodes }
				},
				dom
			};
		}
		return { dom };
	}

	function _updateDom({ current, next }: UpdateDomInstruction): ProcessResult {
		const parentDomNode = findParentDomNode(current);
		next.domNode = current.domNode;
		next.namespace = current.namespace;
		if (next.node.text && next.node.text !== current.node.text) {
			const updatedTextNode = parentDomNode!.ownerDocument!.createTextNode(next.node.text!);
			parentDomNode!.replaceChild(updatedTextNode, next.domNode!);
			next.domNode = updatedTextNode;
		} else if (next.node.children) {
			const children = renderedToWrapper(next.node.children, next, current);
			next.childrenWrappers = children;
		}
		return {
			item: {
				current: current.childrenWrappers,
				next: next.childrenWrappers,
				meta: {}
			},
			dom: { type: 'update', next, current }
		};
	}

	function _removeDom({ current }: RemoveDomInstruction): ProcessResult {
		_wrapperSiblingMap.delete(current);
		_parentWrapperMap.delete(current);
		if (current.hasAnimations) {
			return {
				item: { current: current.childrenWrappers, meta: {} },
				dom: { type: 'delete', current }
			};
		}

		if (current.childrenWrappers) {
			_deferredRenderCallbacks.push(() => {
				let wrappers = current.childrenWrappers || [];
				let wrapper: DNodeWrapper | undefined;
				while ((wrapper = wrappers.pop())) {
					if (isWNodeWrapper(wrapper)) {
						wrapper = _idToWrapperMap.get(wrapper.id) || wrapper;
						_idToWrapperMap.delete(wrapper.id);
						if (wrapper.instance) {
							const instanceData = widgetInstanceMap.get(wrapper.instance);
							instanceData && instanceData.onDetach();
							wrapper.instance = undefined;
						} else {
							const meta = widgetMetaMap.get(wrapper.id);
							if (meta) {
								meta.registryHandler.destroy();
								widgetMetaMap.delete(wrapper.id);
							}
						}
					}
					if (wrapper.childrenWrappers) {
						wrappers.push(...wrapper.childrenWrappers);
						wrapper.childrenWrappers = undefined;
					}
					_wrapperSiblingMap.delete(wrapper);
					_parentWrapperMap.delete(wrapper);
					wrapper.domNode = undefined;
				}
			});
		}

		return {
			dom: { type: 'delete', current }
		};
	}

	return {
		mount,
		invalidate
	};
}

export default renderer;
